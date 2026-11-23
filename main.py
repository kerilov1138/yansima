import asyncio
import base64
import ctypes
import fractions
import hashlib
import json
import os
import queue
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor

import eel
import mss
import numpy as np
import paho.mqtt.client as mqtt
import pyautogui
import pystray
import sounddevice as sd
from aiortc import (
    MediaStreamTrack,
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCRtpSender,
    RTCSessionDescription,
)
from av import AudioFrame, AudioResampler, VideoFrame
from PIL import Image

try:
    import dxcam
except Exception:
    dxcam = None

try:
    import pyaudiowpatch as pyaudio_wp
except Exception:
    pyaudio_wp = None

if sys.platform == "win32":
    import winreg

# --- PYTHONW / NO-CONSOLE SAFE STREAMS ---
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

# --- DPI AWARENESS & PYAUTOGUI ---
def set_dpi_awareness():
    if sys.platform == "win32":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


set_dpi_awareness()
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

# --- KONFİGÜRASYON ---
MQTT_BROKERS = [
    ("broker.emqx.io", 8084, "/mqtt"),
    ("broker.hivemq.com", 8884, "/mqtt"),
]
STUN_SERVERS = [
    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
    RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
    RTCIceServer(urls=["stun:stun.cloudflare.com:3478"]),
]

AUDIO_SAMPLE_RATE = 48000
AUDIO_CHANNELS = 1
AUDIO_BLOCKSIZE = 960  # 20ms @ 48kHz (Opus native)

if getattr(sys, "frozen", False):
    eel.init(os.path.join(sys._MEIPASS, "web"))
else:
    eel.init("web")

# --- KEYBOARD MAPPING & UNICODE INPUT ---
KEY_MAP = {
    "Control": "ctrl",
    "Shift": "shift",
    "Alt": "alt",
    "AltGraph": "altright",
    "Meta": "win",
    "Enter": "enter",
    "Backspace": "backspace",
    "Tab": "tab",
    "Escape": "esc",
    " ": "space",
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "CapsLock": "capslock",
}
for i in range(1, 13):
    KEY_MAP[f"F{i}"] = f"f{i}"

pressed_keys = set()


def release_all_keys():
    for k in list(pressed_keys):
        try:
            pyautogui.keyUp(k)
        except Exception:
            pass
    pressed_keys.clear()


def send_unicode_text(text):
    """Send arbitrary Unicode/Turkish characters on Windows via SendInput."""
    if sys.platform != "win32":
        pyautogui.write(text)
        return

    PUL = ctypes.POINTER(ctypes.c_ulong)

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", PUL),
        ]

    class INPUT(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_ulong),
            ("ki", KEYBDINPUT),
            ("padding", ctypes.c_ubyte * 8),
        ]

    KEYEVENTF_UNICODE = 0x0004
    KEYEVENTF_KEYUP = 0x0002

    for ch in text:
        code = ord(ch)
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inp = INPUT(
                type=1,
                ki=KEYBDINPUT(wVk=0, wScan=code, dwFlags=flags, time=0, dwExtraInfo=None),
            )
            ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))


# --- MACHINE ID & SINGLE-USE TOKEN ---
def generate_machine_id():
    try:
        node = uuid.getnode()
        h = hashlib.sha256(str(node).encode()).hexdigest()
        num = int(h[:8], 16) % 900000000 + 100000000
        return str(num)
    except Exception:
        return str(secrets.randbelow(900000000) + 100000000)


def generate_token():
    return secrets.token_urlsafe(6)


# --- SESSION STATE ---
ui_queue = queue.Queue()


class HostSession:
    def __init__(self):
        self.room_id = generate_machine_id()
        self.current_token = generate_token()
        self.session_active = False
        self.pending_client = None  # dict: {clientId, token, device}
        self.mic_enabled = True
        self.spk_enabled = True
        self.pc = None
        self.mqtt_client = None
        self.active_client_id = None
        self.loop = None
        self.mqtt_online = False
        self.mqtt_text = "Hazırlanıyor..."
        self.control_enabled = True
        self.monitor_index = 1
        self.max_width = 1920
        self.target_fps = 30
        self.audio_source = "both"  # "mic", "system", "both"
        self.privacy_enabled = False
        self.data_channel = None
        self.incoming_files = {}
        self.pending_ice = []
        self.remote_desc_set = False
        self.ui_port = 8000

    def rotate_token(self):
        self.current_token = generate_token()
        ui_queue.put(("update_invite", self.room_id, self.current_token))


session = HostSession()


# --- WEBRTC MEDIA TRACKS ---
class ScreenVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self):
        super().__init__()
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._sct = None
        self._dx = None
        self._dx_idx = None
        self._dx_failed = False
        self._last_rgb = None
        self._start_time = None
        self._frame_count = 0
        self._pts = 0

    def _ensure_dxcam(self, monitor_idx):
        if dxcam is None or self._dx_failed or monitor_idx <= 0:
            return None
        target_idx = monitor_idx - 1
        if self._dx is not None and self._dx_idx == target_idx:
            return self._dx
        if self._dx is not None:
            try:
                del self._dx
            except Exception:
                pass
            self._dx = None
        try:
            self._dx = dxcam.create(output_idx=target_idx, output_color="RGB")
            self._dx_idx = target_idx
            return self._dx
        except Exception as e:
            print(f"[DXGI] dxcam başlatılamadı, mss kullanılacak: {e}")
            self._dx_failed = True
            self._dx = None
            return None

    def _grab_frame(self):
        idx = session.monitor_index
        max_w = session.max_width

        dx = self._ensure_dxcam(idx)
        if dx is not None:
            try:
                arr = dx.grab()
                if arr is not None:
                    h, w = arr.shape[0], arr.shape[1]
                    if w > max_w:
                        img = Image.fromarray(arr)
                        new_h = int(h * (max_w / w))
                        arr = np.asarray(img.resize((max_w, new_h), Image.Resampling.BILINEAR))
                    self._last_rgb = np.ascontiguousarray(arr)
                    return self._last_rgb
                elif self._last_rgb is not None:
                    return self._last_rgb
            except Exception:
                self._dx_failed = True

        if self._sct is None:
            self._sct = mss.mss()
        monitors = self._sct.monitors
        if idx < 0 or idx >= len(monitors):
            idx = 1 if len(monitors) > 1 else 0
        monitor = monitors[idx]
        raw = self._sct.grab(monitor)
        if raw.width > max_w:
            img = Image.frombytes("RGB", raw.size, raw.rgb)
            new_h = int(raw.height * (max_w / raw.width))
            img = img.resize((max_w, new_h), Image.Resampling.BILINEAR)
            self._last_rgb = np.asarray(img)
            return self._last_rgb
        arr = np.frombuffer(raw.rgb, dtype=np.uint8).reshape((raw.height, raw.width, 3))
        self._last_rgb = np.ascontiguousarray(arr)
        return self._last_rgb

    async def recv(self):
        if self._start_time is None:
            self._start_time = time.time()

        fps = max(10, min(60, session.target_fps))
        target_t = self._start_time + (self._frame_count / float(fps))
        delay = target_t - time.time()
        if delay > 0:
            await asyncio.sleep(delay)

        loop = asyncio.get_running_loop()
        rgb = await loop.run_in_executor(self._executor, self._grab_frame)
        frame = VideoFrame.from_ndarray(rgb, format="rgb24")
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, 90000)
        self._pts += int(90000 / fps)
        self._frame_count += 1
        return frame

    def stop(self):
        super().stop()
        if self._dx is not None:
            try:
                del self._dx
            except Exception:
                pass
            self._dx = None
        self._executor.shutdown(wait=False)


class HostMicAudioTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self):
        super().__init__()
        self._q = asyncio.Queue(maxsize=12)
        self._sys_q = asyncio.Queue(maxsize=12)
        self._loop = asyncio.get_running_loop()
        self._pts = 0
        self._start_time = None
        self._frame_count = 0
        self._pts = 0
        self._stream = None
        self._resampler = None
        self._in_rate = AUDIO_SAMPLE_RATE
        self._sys_stop = threading.Event()
        self._sys_thread = None

        try:
            dev = sd.query_devices(kind="input")
            native_rate = int(dev.get("default_samplerate", AUDIO_SAMPLE_RATE)) if dev else AUDIO_SAMPLE_RATE
        except Exception:
            native_rate = AUDIO_SAMPLE_RATE

        for try_rate in (AUDIO_SAMPLE_RATE, native_rate):
            try:
                block = int(round(try_rate * 0.02))
                self._stream = sd.InputStream(
                    samplerate=try_rate,
                    channels=AUDIO_CHANNELS,
                    dtype="int16",
                    blocksize=block,
                    callback=self._audio_cb,
                )
                self._in_rate = try_rate
                if try_rate != AUDIO_SAMPLE_RATE:
                    self._resampler = AudioResampler(format="s16", layout="mono", rate=AUDIO_SAMPLE_RATE)
                self._stream.start()
                break
            except Exception as e:
                print(f"[AUDIO] Mikrofon ({try_rate}Hz) açılamadı: {e}")
                self._stream = None

        if pyaudio_wp is not None and sys.platform == "win32":
            self._sys_thread = threading.Thread(target=self._loopback_worker, daemon=True)
            self._sys_thread.start()

    def _loopback_worker(self):
        p = None
        stream = None
        try:
            p = pyaudio_wp.PyAudio()
            wasapi_info = p.get_host_api_info_by_type(pyaudio_wp.paWASAPI)
            default_spk = p.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
            loopback_dev = None
            if not default_spk.get("isLoopbackDevice", False):
                for lb in p.get_loopback_device_info_generator():
                    if default_spk["name"] in lb["name"]:
                        loopback_dev = lb
                        break
            else:
                loopback_dev = default_spk

            if not loopback_dev:
                return

            rate = int(loopback_dev["defaultSampleRate"])
            ch = max(1, int(loopback_dev["maxInputChannels"]))
            chunk = int(round(rate * 0.02))
            stream = p.open(
                format=pyaudio_wp.paInt16,
                channels=ch,
                rate=rate,
                frames_per_buffer=chunk,
                input=True,
                input_device_index=loopback_dev["index"],
            )
            while not self._sys_stop.is_set():
                data = stream.read(chunk, exception_on_overflow=False)
                arr = np.frombuffer(data, dtype=np.int16)
                if ch > 1:
                    arr = arr.reshape(-1, ch).mean(axis=1).astype(np.int16)
                if rate != AUDIO_SAMPLE_RATE and len(arr) > 0:
                    idx = np.linspace(0, len(arr) - 1, AUDIO_BLOCKSIZE).astype(np.int32)
                    arr = arr[idx]
                self._loop.call_soon_threadsafe(self._enqueue_sys, arr.reshape(-1, 1))
        except Exception as e:
            print(f"[AUDIO] Sistem sesi (WASAPI Loopback) başlatılamadı: {e}")
        finally:
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            if p:
                try:
                    p.terminate()
                except Exception:
                    pass

    def _enqueue_sys(self, pcm):
        if self._sys_q.full():
            try:
                self._sys_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._sys_q.put_nowait(pcm)

    def _audio_cb(self, indata, _frames, _time_info, _status):
        if not session.mic_enabled or session.audio_source == "system":
            pcm = np.zeros((len(indata), 1), dtype=np.int16)
        else:
            pcm = indata.copy()
        try:
            self._loop.call_soon_threadsafe(self._enqueue_nowait, pcm)
        except Exception:
            pass

    def _enqueue_nowait(self, pcm):
        if self._q.full():
            try:
                self._q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._q.put_nowait(pcm)

    async def recv(self):
        if self._start_time is None:
            self._start_time = time.time()

        target_t = self._start_time + (self._frame_count * 0.020)
        delay = target_t - time.time()
        if delay > 0:
            await asyncio.sleep(delay)

        mic_pcm = None
        if session.mic_enabled and session.audio_source in ("mic", "both"):
            try:
                raw_mic = self._q.get_nowait()
                if self._resampler is not None:
                    f = AudioFrame.from_ndarray(raw_mic.T, format="s16", layout="mono")
                    f.sample_rate = self._in_rate
                    res = self._resampler.resample(f)
                    if res:
                        mic_pcm = res[0].to_ndarray().reshape(-1, 1)
                else:
                    mic_pcm = raw_mic
            except asyncio.QueueEmpty:
                pass

        sys_pcm = None
        if session.audio_source in ("system", "both"):
            try:
                sys_pcm = self._sys_q.get_nowait()
            except asyncio.QueueEmpty:
                pass

        if mic_pcm is not None and sys_pcm is not None:
            n = min(len(mic_pcm), len(sys_pcm), AUDIO_BLOCKSIZE)
            mixed = np.clip(
                mic_pcm[:n].astype(np.int32) + sys_pcm[:n].astype(np.int32),
                -32768,
                32767,
            ).astype(np.int16)
            if n < AUDIO_BLOCKSIZE:
                mixed = np.pad(mixed, ((0, AUDIO_BLOCKSIZE - n), (0, 0)))
        elif mic_pcm is not None:
            mixed = mic_pcm[:AUDIO_BLOCKSIZE]
            if len(mixed) < AUDIO_BLOCKSIZE:
                mixed = np.pad(mixed, ((0, AUDIO_BLOCKSIZE - len(mixed)), (0, 0)))
        elif sys_pcm is not None:
            mixed = sys_pcm[:AUDIO_BLOCKSIZE]
            if len(mixed) < AUDIO_BLOCKSIZE:
                mixed = np.pad(mixed, ((0, AUDIO_BLOCKSIZE - len(mixed)), (0, 0)))
        else:
            mixed = np.zeros((AUDIO_BLOCKSIZE, 1), dtype=np.int16)

        frame = AudioFrame.from_ndarray(mixed.T, format="s16", layout="mono")
        frame.sample_rate = AUDIO_SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, AUDIO_SAMPLE_RATE)
        self._pts += AUDIO_BLOCKSIZE
        self._frame_count += 1
        return frame

    def stop(self):
        super().stop()
        self._sys_stop.set()
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None


async def play_remote_audio(track):
    stream = None
    resampler = AudioResampler(format="s16", layout="mono", rate=AUDIO_SAMPLE_RATE)
    try:
        stream = sd.OutputStream(
            samplerate=AUDIO_SAMPLE_RATE,
            channels=AUDIO_CHANNELS,
            dtype="int16",
        )
        stream.start()
        while session.session_active:
            frame = await track.recv()
            if not session.spk_enabled:
                continue
            for resampled in resampler.resample(frame):
                arr = resampled.to_ndarray()
                pcm = arr.reshape(-1, 1).astype(np.int16)
                stream.write(pcm)
    except Exception:
        pass
    finally:
        if stream:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass


# --- PRIVACY SCREEN OVERLAY (WINDOWS) ---
class PrivacyScreenManager:
    def __init__(self):
        self._proc = None
        self._stop_evt = None
        self._thread = None

    def set_enabled(self, enabled):
        if sys.platform != "win32":
            return False
        if enabled:
            if self._thread and self._thread.is_alive():
                return True
            self._stop_evt = threading.Event()
            self._thread = threading.Thread(target=self._run_overlay, daemon=True)
            self._thread.start()
            return True
        else:
            if self._stop_evt:
                self._stop_evt.set()
            return False

    def _run_overlay(self):
        try:
            import tkinter as tk

            root = tk.Tk()
            root.overrideredirect(True)
            root.configure(bg="black")
            root.attributes("-topmost", True)
            with mss.mss() as sct:
                m = sct.monitors[0]
                root.geometry(f"{m['width']}x{m['height']}+{m['left']}+{m['top']}")
            root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(root.winfo_id()) or root.winfo_id()

            # Exclude from screen capture (WDA_EXCLUDEFROMCAPTURE = 0x11)
            ctypes.windll.user32.SetWindowDisplayAffinity(hwnd, 0x00000011)

            # Click-through & no-activate so remote mouse/keyboard pass through
            GWL_EXSTYLE = -20
            WS_EX_TRANSPARENT = 0x00000020
            WS_EX_LAYERED = 0x00080000
            WS_EX_NOACTIVATE = 0x08000000
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ctypes.windll.user32.SetWindowLongW(
                hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE
            )

            def _poll():
                if self._stop_evt and self._stop_evt.is_set():
                    root.destroy()
                    return
                root.after(100, _poll)

            root.after(100, _poll)
            root.mainloop()
        except Exception as e:
            print(f"[PRIVACY] Ekran karartma hatası: {e}")


privacy_screen = PrivacyScreenManager()


# --- CLIPBOARD HELPERS (WINDOWS) ---
def get_windows_clipboard():
    if sys.platform != "win32":
        return ""
    CF_UNICODETEXT = 13
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    if not user32.OpenClipboard(None):
        return ""
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    except Exception:
        return ""
    finally:
        user32.CloseClipboard()


def set_windows_clipboard(text):
    if sys.platform != "win32":
        return
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    data = (text + "\0").encode("utf-16-le")
    if not user32.OpenClipboard(None):
        return
    try:
        user32.EmptyClipboard()
        h_mem = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h_mem:
            return
        ptr = kernel32.GlobalLock(h_mem)
        if ptr:
            ctypes.memmove(ptr, data, len(data))
            kernel32.GlobalUnlock(h_mem)
            user32.SetClipboardData(CF_UNICODETEXT, h_mem)
    except Exception:
        pass
    finally:
        user32.CloseClipboard()


# --- CONTROL COMMAND PROCESSOR ---
def process_control_command(cmd_str, channel=None):
    try:
        if cmd_str == "CLIP_GET":
            txt = get_windows_clipboard()
            if channel and channel.readyState == "open":
                b64 = base64.b64encode(txt.encode("utf-8")).decode("ascii")
                channel.send(f"CLIP_DATA:{b64}")
            return

        if ":" not in cmd_str:
            return
        cmd, val = cmd_str.split(":", 1)

        if cmd == "CLIP_SET":
            try:
                txt = base64.b64decode(val.encode("ascii")).decode("utf-8")
                set_windows_clipboard(txt)
            except Exception:
                pass
            return

        if cmd == "CHAT":
            try:
                txt = base64.b64decode(val.encode("ascii")).decode("utf-8")
                ui_queue.put(("chat_msg", "Uzak Cihaz", txt))
            except Exception:
                pass
            return

        if cmd == "PRIVACY":
            if session.control_enabled:
                enabled = val == "on"
                session.privacy_enabled = enabled
                privacy_screen.set_enabled(enabled)
                ui_queue.put(("privacy_state", enabled))
            return

        if cmd == "FILE_START":
            parts = val.split(":", 2)
            if len(parts) >= 2:
                fid, fname = parts[0], os.path.basename(parts[1]) or "dosya"
                dl_dir = os.path.join(os.path.expanduser("~"), "Downloads", "Yansima")
                os.makedirs(dl_dir, exist_ok=True)
                fpath = os.path.join(dl_dir, fname)
                session.incoming_files[fid] = {"path": fpath, "chunks": []}
            return

        if cmd == "FILE_CHUNK":
            fid, b64 = val.split(":", 1)
            entry = session.incoming_files.get(fid)
            if entry is not None:
                entry["chunks"].append(base64.b64decode(b64.encode("ascii")))
            return

        if cmd == "FILE_END":
            entry = session.incoming_files.pop(val, None)
            if entry is not None:
                with open(entry["path"], "wb") as f:
                    for ch in entry["chunks"]:
                        f.write(ch)
                print(f"[FILE] Kaydedildi: {entry['path']}")
            return

        if not session.control_enabled:
            return

        screen_w, screen_h = pyautogui.size()

        if cmd == "COMBO":
            keys = [k.strip() for k in val.split("+") if k.strip()]
            if len(keys) == 1:
                pyautogui.press(keys[0])
            elif len(keys) > 1:
                pyautogui.hotkey(*keys)
            return

        if cmd == "MOVE":
            x, y = map(float, val.split(","))
            tx, ty = int(x * screen_w), int(y * screen_h)
            if sys.platform == "win32":
                ctypes.windll.user32.SetCursorPos(tx, ty)
            else:
                pyautogui.moveTo(tx, ty)
        elif cmd == "MDOWN":
            btn, sx, sy = val.split(",")
            pyautogui.mouseDown(x=int(float(sx) * screen_w), y=int(float(sy) * screen_h), button=btn)
        elif cmd == "MUP":
            btn, sx, sy = val.split(",")
            pyautogui.mouseUp(x=int(float(sx) * screen_w), y=int(float(sy) * screen_h), button=btn)
        elif cmd == "CLICK":
            x, y = map(float, val.split(","))
            pyautogui.click(int(x * screen_w), int(y * screen_h))
        elif cmd == "RCLICK":
            x, y = map(float, val.split(","))
            pyautogui.rightClick(int(x * screen_w), int(y * screen_h))
        elif cmd == "DCLICK":
            x, y = map(float, val.split(","))
            pyautogui.doubleClick(int(x * screen_w), int(y * screen_h))
        elif cmd == "SCROLL":
            _dx, dy = map(float, val.split(","))
            pyautogui.scroll(int(dy))
        elif cmd == "KDOWN":
            mapped = KEY_MAP.get(val, val.lower() if len(val) == 1 else val)
            if mapped not in pressed_keys:
                pyautogui.keyDown(mapped)
                pressed_keys.add(mapped)
        elif cmd == "KUP":
            mapped = KEY_MAP.get(val, val.lower() if len(val) == 1 else val)
            pyautogui.keyUp(mapped)
            pressed_keys.discard(mapped)
        elif cmd == "TEXT":
            send_unicode_text(val)
    except Exception as e:
        print(f"[CONTROL] Komut hatası ({cmd_str}): {e}")


# --- WEBRTC PEER CONNECTION LIFECYCLE ---
def publish_to_client(client_id, payload):
    if session.mqtt_client and client_id:
        topic = f"yansima/v1/{session.room_id}/to-client/{client_id}"
        session.mqtt_client.publish(topic, json.dumps(payload))


async def handle_offer(client_id, sdp, sdp_type):
    await close_peer_connection(rotate=False)

    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=STUN_SERVERS))
    session.pc = pc
    session.active_client_id = client_id
    session.session_active = True
    session.remote_desc_set = False
    session.mic_enabled = True
    session.spk_enabled = True

    video_track = ScreenVideoTrack()
    audio_track = HostMicAudioTrack()
    pc.addTrack(video_track)
    pc.addTrack(audio_track)

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            asyncio.create_task(play_remote_audio(track))

    @pc.on("datachannel")
    def on_datachannel(channel):
        session.data_channel = channel

        @channel.on("open")
        def on_open():
            try:
                channel.send(f"MODE:{'control' if session.control_enabled else 'readonly'}")
            except Exception:
                pass

        async def _cursor_sync():
            last_pos = None
            while session.pc is pc and session.session_active:
                try:
                    if channel.readyState == "open":
                        px, py = pyautogui.position()
                        sw, sh = pyautogui.size()
                        if sw > 0 and sh > 0 and (px, py) != last_pos:
                            last_pos = (px, py)
                            channel.send(f"CURSOR:{px / sw:.4f},{py / sh:.4f}")
                except Exception:
                    pass
                await asyncio.sleep(0.06)

        asyncio.create_task(_cursor_sync())

        @channel.on("message")
        def on_message(message):
            if isinstance(message, str):
                process_control_command(message, channel=channel)

        @channel.on("close")
        def on_close():
            async def _check_dc_close():
                await asyncio.sleep(2)
                if session.pc is pc:
                    await close_peer_connection(rotate=True)

            asyncio.create_task(_check_dc_close())

    @pc.on("icecandidate")
    def on_icecandidate(candidate):
        if candidate:
            publish_to_client(
                client_id,
                {
                    "type": "ice",
                    "candidate": {
                        "candidate": f"candidate:{candidate.foundation} {candidate.component} {candidate.protocol} {candidate.priority} {candidate.ip} {candidate.port} typ {candidate.type}",
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex,
                    },
                },
            )

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"[WEBRTC] Durum: {pc.connectionState}")
        if pc.connectionState == "connected":
            ui_queue.put(("show_host_view",))
        elif pc.connectionState == "disconnected":
            await asyncio.sleep(5)
            if session.pc is pc and pc.connectionState in ("disconnected", "failed", "closed"):
                await close_peer_connection(rotate=True)
        elif pc.connectionState in ("failed", "closed"):
            if session.pc is pc:
                await close_peer_connection(rotate=True)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        session.remote_desc_set = True
        for cand_dict in list(session.pending_ice):
            await handle_remote_ice(cand_dict)
        session.pending_ice.clear()

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        publish_to_client(
            client_id,
            {
                "type": "answer",
                "sdp": pc.localDescription.sdp,
                "sdpType": pc.localDescription.type,
            },
        )
    except Exception as e:
        print(f"[WEBRTC] Offer işleme hatası: {e}")
        await close_peer_connection(rotate=True)


async def handle_remote_ice(cand_dict):
    if not cand_dict:
        return
    if not session.pc or not session.remote_desc_set:
        session.pending_ice.append(cand_dict)
        return
    try:
        cand_str = cand_dict.get("candidate", "")
        if not cand_str:
            return
        # Parse standard WebRTC ICE candidate string: "candidate:<foundation> <comp> <proto> <prio> <ip> <port> typ <type> ..."
        parts = cand_str.replace("candidate:", "").split()
        if len(parts) < 8:
            return
        ip = parts[4]
        proto = parts[2]
        if ip.endswith(".local") or proto.lower() != "udp":
            return
        cand = RTCIceCandidate(
            component=int(parts[1]),
            foundation=parts[0],
            ip=ip,
            port=int(parts[5]),
            priority=int(parts[3]),
            protocol=proto,
            type=parts[7],
            sdpMid=cand_dict.get("sdpMid"),
            sdpMLineIndex=cand_dict.get("sdpMLineIndex"),
        )
        await session.pc.addIceCandidate(cand)
    except Exception as e:
        print(f"[WEBRTC] ICE ekleme hatası: {e}")


async def close_peer_connection(rotate=True):
    was_active = session.session_active or (session.pc is not None)
    session.session_active = False
    session.remote_desc_set = False
    session.pending_ice.clear()
    release_all_keys()

    pc_to_close = session.pc
    session.pc = None
    if pc_to_close:
        try:
            for sender in pc_to_close.getSenders():
                if sender.track:
                    try:
                        sender.track.stop()
                    except Exception:
                        pass
            await asyncio.wait_for(pc_to_close.close(), timeout=2.0)
        except Exception:
            pass

    session.active_client_id = None
    session.pending_client = None
    session.data_channel = None
    session.control_enabled = True
    session.privacy_enabled = False
    privacy_screen.set_enabled(False)
    session.mic_enabled = True
    session.spk_enabled = True

    if rotate and was_active:
        session.rotate_token()
        ui_queue.put(("host_ended",))


# --- MQTT SIGNALING WORKER ---
def start_mqtt_worker():
    broker_idx = 0
    to_host_topic = f"yansima/v1/{session.room_id}/to-host"

    def connect_next():
        nonlocal broker_idx
        host, port, ws_path = MQTT_BROKERS[broker_idx % len(MQTT_BROKERS)]
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, transport="websockets")
        client.ws_set_options(path=ws_path)
        client.tls_set()

        def on_connect(c, _userdata, _flags, reason_code, _props=None):
            if reason_code == 0:
                c.subscribe(to_host_topic)
                session.mqtt_online = True
                session.mqtt_text = "Çevrimiçi (Hazır)"
                ui_queue.put(("mqtt_status", True, "Çevrimiçi (Hazır)"))
                print(f"[MQTT] Bağlandı -> {host}:{port}")
            else:
                session.mqtt_online = False
                session.mqtt_text = "Sinyal Hatası"
                ui_queue.put(("mqtt_status", False, "Sinyal Hatası"))

        def on_disconnect(_c, _userdata, _flags, _reason_code, _props=None):
            session.mqtt_online = False
            session.mqtt_text = "Yeniden bağlanılıyor..."
            ui_queue.put(("mqtt_status", False, "Yeniden bağlanılıyor..."))

        def on_message(_c, _userdata, msg):
            try:
                data = json.loads(msg.payload.decode("utf-8"))
            except Exception:
                return

            mtype = data.get("type")
            cid = data.get("clientId")
            tok = data.get("token")

            if tok != session.current_token:
                if mtype in ("join", "offer"):
                    publish_to_client(
                        cid,
                        {"type": "rejected", "reason": "Tek seferlik şifre geçersiz veya süresi dolmuş."},
                    )
                return

            if mtype == "join":
                if session.pending_client is not None:
                    # Expire stale pending requests after 30s or allow retry from same clientId
                    if (
                        session.pending_client.get("clientId") == cid
                        or (time.time() - session.pending_client.get("ts", 0)) > 30
                    ):
                        session.pending_client = None
                if session.session_active or session.pending_client is not None:
                    publish_to_client(cid, {"type": "rejected", "reason": "Bu bilgisayar şu anda başka bir oturumda."})
                    return
                session.pending_client = {
                    "clientId": cid,
                    "token": tok,
                    "device": data.get("device", "Uzak Cihaz"),
                    "ts": time.time(),
                }
                ui_queue.put(("show_request", session.pending_client["device"]))

            elif mtype == "offer":
                if session.loop:
                    asyncio.run_coroutine_threadsafe(
                        handle_offer(cid, data.get("sdp"), data.get("sdpType", "offer")),
                        session.loop,
                    )

            elif mtype == "ice":
                if session.loop:
                    asyncio.run_coroutine_threadsafe(
                        handle_remote_ice(data.get("candidate")),
                        session.loop,
                    )

            elif mtype == "bye":
                if session.pending_client and session.pending_client.get("clientId") == cid:
                    session.pending_client = None
                    ui_queue.put(("host_ended",))
                if session.loop:
                    asyncio.run_coroutine_threadsafe(close_peer_connection(rotate=True), session.loop)

        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = on_message
        session.mqtt_client = client

        try:
            client.connect(host, port, keepalive=45)
            client.loop_forever()
        except Exception as e:
            print(f"[MQTT] Bağlantı hatası ({host}): {e}")
            broker_idx += 1
            time.sleep(3)
            connect_next()

    connect_next()


def start_asyncio_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    session.loop = loop
    loop.run_forever()


# --- EEL API ---
@eel.expose
def get_invite_info():
    return {
        "room": session.room_id,
        "token": session.current_token,
        "mqtt_online": session.mqtt_online,
        "mqtt_text": session.mqtt_text,
    }


@eel.expose
def regenerate_invite():
    if session.pc is not None and session.loop is not None:
        asyncio.run_coroutine_threadsafe(close_peer_connection(rotate=False), session.loop)
    session.session_active = False
    session.pending_client = None
    session.active_client_id = None
    session.rotate_token()
    return {"room": session.room_id, "token": session.current_token}


@eel.expose
def get_monitors():
    try:
        with mss.mss() as sct:
            res = []
            for idx, m in enumerate(sct.monitors):
                if idx == 0:
                    res.append({"index": 0, "label": f"Tüm Ekranlar ({m['width']}x{m['height']})"})
                else:
                    res.append({"index": idx, "label": f"Ekran {idx} ({m['width']}x{m['height']})"})
            return res
    except Exception:
        return [{"index": 1, "label": "Ana Ekran"}]


@eel.expose
def set_stream_settings(monitor_idx, quality):
    try:
        session.monitor_index = int(monitor_idx)
    except Exception:
        pass
    q_map = {
        "low": (1280, 15),
        "medium": (1600, 24),
        "high": (1920, 30),
        "ultra": (1920, 60),
    }
    max_w, fps = q_map.get(quality, (1920, 30))
    session.max_width = max_w
    session.target_fps = fps


@eel.expose
def set_audio_source(src):
    if src in ("mic", "system", "both"):
        session.audio_source = src


@eel.expose
def set_privacy_screen(enabled):
    session.privacy_enabled = bool(enabled)
    privacy_screen.set_enabled(session.privacy_enabled)
    if session.data_channel and session.data_channel.readyState == "open" and session.loop:
        msg = f"PRIVACY:{'on' if session.privacy_enabled else 'off'}"
        session.loop.call_soon_threadsafe(session.data_channel.send, msg)


@eel.expose
def host_send_chat(text):
    if not text or not session.data_channel or session.data_channel.readyState != "open":
        return False
    b64 = base64.b64encode(str(text).encode("utf-8")).decode("ascii")
    if session.loop:
        session.loop.call_soon_threadsafe(session.data_channel.send, f"CHAT:{b64}")
    return True


@eel.expose
def host_send_file():
    if not session.data_channel or session.data_channel.readyState != "open":
        return {"ok": False, "error": "Aktif bağlantı yok."}

    def _pick_and_send():
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askopenfilename(title="Karşı Tarafa Gönderilecek Dosyayı Seçin")
            root.destroy()
            if not path:
                return
            fname = os.path.basename(path)
            size = os.path.getsize(path)
            fid = secrets.token_hex(4)
            if session.loop and session.data_channel and session.data_channel.readyState == "open":
                session.loop.call_soon_threadsafe(session.data_channel.send, f"FILE_START:{fid}:{fname}:{size}")
                with open(path, "rb") as f:
                    while True:
                        chunk = f.read(24576)
                        if not chunk:
                            break
                        b64 = base64.b64encode(chunk).decode("ascii")
                        session.loop.call_soon_threadsafe(session.data_channel.send, f"FILE_CHUNK:{fid}:{b64}")
                        time.sleep(0.005)
                session.loop.call_soon_threadsafe(session.data_channel.send, f"FILE_END:{fid}")
        except Exception as e:
            print(f"[FILE] Gönderim hatası: {e}")

    threading.Thread(target=_pick_and_send, daemon=True).start()
    return {"ok": True}


@eel.expose
def get_autostart():
    if sys.platform != "win32":
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, "Yansima")
            return True
    except Exception:
        return False


@eel.expose
def set_autostart(enabled):
    if sys.platform != "win32":
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                if getattr(sys, "frozen", False):
                    cmd = f'"{sys.executable}"'
                else:
                    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
                    if not os.path.exists(pyw):
                        pyw = sys.executable
                    cmd = f'"{pyw}" "{os.path.abspath(__file__)}"'
                winreg.SetValueEx(key, "Yansima", 0, winreg.REG_SZ, cmd)
            else:
                try:
                    winreg.DeleteValue(key, "Yansima")
                except FileNotFoundError:
                    pass
        return True
    except Exception as e:
        print(f"[AUTOSTART] Hata: {e}")
        return False


@eel.expose
def set_control_mode(enabled):
    session.control_enabled = bool(enabled)
    if not session.control_enabled:
        release_all_keys()
    if session.data_channel and session.data_channel.readyState == "open" and session.loop:
        mode_msg = f"MODE:{'control' if session.control_enabled else 'readonly'}"
        session.loop.call_soon_threadsafe(session.data_channel.send, mode_msg)


@eel.expose
def respond_to_request(allow, control_allowed=True):
    pending = session.pending_client
    if not pending:
        return
    cid = pending["clientId"]
    if allow:
        session.control_enabled = bool(control_allowed)
        publish_to_client(cid, {"type": "accepted"})

        def _expire_if_no_offer():
            time.sleep(20)
            if (
                not session.session_active
                and session.pending_client
                and session.pending_client.get("clientId") == cid
            ):
                session.pending_client = None
                ui_queue.put(("host_ended",))

        threading.Thread(target=_expire_if_no_offer, daemon=True).start()
    else:
        session.pending_client = None
        publish_to_client(cid, {"type": "rejected", "reason": "Bağlantı isteği reddedildi."})


@eel.expose
def toggle_audio(mic, spk):
    session.mic_enabled = bool(mic)
    session.spk_enabled = bool(spk)


@eel.expose
def stop_session():
    if session.active_client_id:
        publish_to_client(session.active_client_id, {"type": "bye"})
    if session.loop:
        asyncio.run_coroutine_threadsafe(close_peer_connection(rotate=True), session.loop)


def find_free_port(start_port=8000):
    for p in range(start_port, start_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return 0


def open_ui_window():
    url = f"http://localhost:{session.ui_port}/index.html"
    for browser in (
        os.path.join(os.environ.get("ProgramFiles", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    ):
        if browser and os.path.exists(browser):
            try:
                subprocess.Popen([browser, f"--app={url}", "--window-size=960,680"])
                return
            except Exception:
                pass
    webbrowser.open(url)


def start_tray_icon():
    base_dir = sys._MEIPASS if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
    ico_path = os.path.join(base_dir, "screen.ico")
    if os.path.exists(ico_path):
        icon_img = Image.open(ico_path)
    else:
        icon_img = Image.new("RGB", (64, 64), (239, 57, 69))

    def on_open(icon, item):
        open_ui_window()

    def on_toggle_autostart(icon, item):
        set_autostart(not get_autostart())

    def on_exit(icon, item):
        try:
            icon.stop()
        except Exception:
            pass
        os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem("Pencereyi Aç", on_open, default=True),
        pystray.MenuItem("Windows Başlangıcında Çalıştır", on_toggle_autostart, checked=lambda item: get_autostart()),
        pystray.MenuItem("Çıkış", on_exit),
    )
    tray = pystray.Icon("Yansima", icon_img, "Yansıma - Uzak Masaüstü", menu)
    tray.run()


def on_eel_close(_page, _sockets):
    # Pencere kapatıldığında uygulama sistem tepsisinde (tray) çalışmaya devam eder
    pass


# --- MAIN ---
if __name__ == "__main__":
    session.ui_port = find_free_port(8000)
    threading.Thread(target=start_asyncio_loop, daemon=True).start()
    threading.Thread(target=start_mqtt_worker, daemon=True).start()
    threading.Thread(target=start_tray_icon, daemon=True).start()

    eel.start("index.html", size=(960, 680), port=session.ui_port, block=False, close_callback=on_eel_close)

    while True:
        try:
            while not ui_queue.empty():
                ev = ui_queue.get_nowait()
                if ev[0] == "mqtt_status":
                    eel.update_mqtt_status(ev[1], ev[2])()
                elif ev[0] == "update_invite":
                    eel.update_invite_ui(ev[1], ev[2])()
                elif ev[0] == "show_request":
                    eel.show_connection_request(ev[1])()
                elif ev[0] == "show_host_view":
                    eel.showHostView()()
                elif ev[0] == "host_ended":
                    eel.on_host_session_ended()()
                elif ev[0] == "chat_msg":
                    eel.on_host_chat_message(ev[1], ev[2])()
                elif ev[0] == "privacy_state":
                    eel.on_host_privacy_state(ev[1])()
        except Exception:
            pass
        eel.sleep(0.05)
