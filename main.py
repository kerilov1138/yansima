import asyncio
import ctypes
import fractions
import hashlib
import json
import os
import queue
import secrets
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import eel
import mss
import numpy as np
import paho.mqtt.client as mqtt
import pyautogui
import sounddevice as sd
from aiortc import (
    MediaStreamTrack,
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from av import AudioFrame, AudioResampler, VideoFrame
from PIL import Image

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
        self._start_time = None
        self._frame_count = 0

    def _grab_frame(self):
        if self._sct is None:
            self._sct = mss.mss()
        monitor = self._sct.monitors[1]
        raw = self._sct.grab(monitor)
        if raw.width > 1920:
            img = Image.frombytes("RGB", raw.size, raw.rgb)
            new_h = int(raw.height * (1920 / raw.width))
            img = img.resize((1920, new_h), Image.Resampling.BILINEAR)
            return np.asarray(img)
        arr = np.frombuffer(raw.rgb, dtype=np.uint8).reshape((raw.height, raw.width, 3))
        return np.ascontiguousarray(arr)

    async def recv(self):
        if self._start_time is None:
            self._start_time = time.time()

        # Target ~25 FPS
        target_t = self._start_time + (self._frame_count / 25.0)
        delay = target_t - time.time()
        if delay > 0:
            await asyncio.sleep(delay)

        loop = asyncio.get_running_loop()
        rgb = await loop.run_in_executor(self._executor, self._grab_frame)
        frame = VideoFrame.from_ndarray(rgb, format="rgb24")
        frame.pts = self._frame_count * 3600  # 90kHz / 25fps
        frame.time_base = fractions.Fraction(1, 90000)
        self._frame_count += 1
        return frame

    def stop(self):
        super().stop()
        self._executor.shutdown(wait=False)


class HostMicAudioTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self):
        super().__init__()
        self._q = asyncio.Queue(maxsize=12)
        self._loop = asyncio.get_running_loop()
        self._pts = 0
        self._start_time = None
        self._frame_count = 0
        self._stream = None
        self._resampler = None
        self._in_rate = AUDIO_SAMPLE_RATE
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

    def _audio_cb(self, indata, _frames, _time_info, _status):
        if not session.mic_enabled:
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

        try:
            pcm = self._q.get_nowait()
        except asyncio.QueueEmpty:
            pcm = np.zeros((AUDIO_BLOCKSIZE, 1), dtype=np.int16)
            frame = AudioFrame.from_ndarray(pcm.T, format="s16", layout="mono")
            frame.sample_rate = AUDIO_SAMPLE_RATE
            frame.pts = self._pts
            frame.time_base = fractions.Fraction(1, AUDIO_SAMPLE_RATE)
            self._pts += AUDIO_BLOCKSIZE
            self._frame_count += 1
            return frame

        frame = AudioFrame.from_ndarray(pcm.T, format="s16", layout="mono")
        frame.sample_rate = self._in_rate
        if self._resampler is not None:
            resampled = self._resampler.resample(frame)
            if resampled:
                frame = resampled[0]
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, AUDIO_SAMPLE_RATE)
        self._pts += frame.samples
        self._frame_count += 1
        return frame

    def stop(self):
        super().stop()
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


# --- CONTROL COMMAND PROCESSOR ---
def process_control_command(cmd_str):
    try:
        if ":" not in cmd_str:
            return
        cmd, val = cmd_str.split(":", 1)
        screen_w, screen_h = pyautogui.size()

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
                process_control_command(message)

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

    await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
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


async def handle_remote_ice(cand_dict):
    if not session.pc or not cand_dict:
        return
    try:
        cand_str = cand_dict.get("candidate", "")
        if not cand_str:
            return
        # Parse standard WebRTC ICE candidate string: "candidate:<foundation> <comp> <proto> <prio> <ip> <port> typ <type> ..."
        parts = cand_str.replace("candidate:", "").split()
        if len(parts) < 8:
            return
        cand = RTCIceCandidate(
            component=int(parts[1]),
            foundation=parts[0],
            ip=parts[4],
            port=int(parts[5]),
            priority=int(parts[3]),
            protocol=parts[2],
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
    release_all_keys()

    if session.pc:
        try:
            for sender in session.pc.getSenders():
                if sender.track:
                    sender.track.stop()
            await session.pc.close()
        except Exception:
            pass
        session.pc = None

    session.active_client_id = None
    session.pending_client = None
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
    if not session.session_active:
        session.rotate_token()


@eel.expose
def respond_to_request(allow):
    pending = session.pending_client
    if not pending:
        return
    cid = pending["clientId"]
    if allow:
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


# --- MAIN ---
if __name__ == "__main__":
    threading.Thread(target=start_asyncio_loop, daemon=True).start()
    threading.Thread(target=start_mqtt_worker, daemon=True).start()

    eel.start("index.html", size=(920, 620), block=False)

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
        except Exception:
            pass
        eel.sleep(0.05)
