const isDesktopApp = (typeof eel !== "undefined" && !window.__NO_EEL__);

const MQTT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt"
];

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];

let disconnectGraceTimer = null;

let currentRoom = "";
let currentToken = "";
let mqttClient = null;
let pc = null;
let dc = null;
let audioSender = null;
let localMicStream = null;
let clientId = "c_" + Math.random().toString(36).slice(2, 10);

let micEnabled = false;
let spkEnabled = true;
let rightClickMode = false;
let hostMicState = true;
let hostSpkState = true;

// --- INITIALIZATION ---
window.addEventListener("DOMContentLoaded", async () => {
    const modeBadge = document.getElementById("mode-badge");
    const hostCard = document.getElementById("host-card");

    if (isDesktopApp) {
        modeBadge.innerText = "Masaüstü Uygulaması (Host & İstemci)";
        const savedBase = localStorage.getItem("yansima_pages_url") || "https://kerilov1138.github.io/yansima/";
        document.getElementById("pages-base-url").value = savedBase;

        try {
            const info = await eel.get_invite_info()();
            update_invite_ui(info.room, info.token);
            if (typeof info.mqtt_online === "boolean" && info.mqtt_text) {
                setStatus(info.mqtt_online, info.mqtt_text);
            }
        } catch (e) {
            console.error("Eel init hatası:", e);
        }
    } else {
        hostCard.classList.add("hidden");
        modeBadge.innerText = "Tarayıcı / Mobil İstemci";
        setStatus(true, "Bağlanmaya Hazır");
    }

    // Parse ?room=...&token=... from invite URL
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get("room");
    const urlToken = params.get("token");
    if (urlRoom) document.getElementById("remote-room").value = urlRoom;
    if (urlToken) document.getElementById("remote-token").value = urlToken;
});

function setStatus(online, text) {
    const dot = document.getElementById("status-dot");
    const label = document.getElementById("status-text");
    if (online) dot.classList.remove("offline");
    else dot.classList.add("offline");
    label.innerText = text;
}

if (isDesktopApp) {
    eel.expose(update_mqtt_status);
    eel.expose(update_invite_ui);
    eel.expose(show_connection_request);
    eel.expose(showHostView);
    eel.expose(on_host_session_ended);
}

function update_mqtt_status(online, text) {
    setStatus(online, text);
}

function update_invite_ui(room, token) {
    currentRoom = room;
    currentToken = token;
    document.getElementById("my-room").value = formatRoom(room);
    document.getElementById("my-token").value = token;
    refreshInviteLink();
}

function formatRoom(r) {
    const clean = (r || "").replace(/\D/g, "");
    if (clean.length === 9) {
        return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6)}`;
    }
    return r;
}

function savePagesBaseUrl() {
    const val = document.getElementById("pages-base-url").value.trim();
    if (val) {
        localStorage.setItem("yansima_pages_url", val);
        refreshInviteLink();
    }
}

function refreshInviteLink() {
    const baseInput = document.getElementById("pages-base-url").value.trim();
    const base = baseInput || "https://kerilov1138.github.io/yansima/";
    const sep = base.includes("?") ? "&" : "?";
    const cleanRoom = (currentRoom || "").replace(/\D/g, "");
    document.getElementById("invite-link").value = `${base}${sep}room=${cleanRoom}&token=${currentToken}`;
}

function regenerateInvite() {
    if (isDesktopApp) {
        eel.regenerate_invite()();
    }
}

function copyText(elementId, btn) {
    const el = document.getElementById(elementId);
    el.select();
    el.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(el.value);
    const orig = btn.innerHTML;
    btn.innerHTML = "✓";
    setTimeout(() => { btn.innerHTML = orig; }, 1600);
}

// --- HOST UI HANDLERS ---
function show_connection_request(info) {
    document.getElementById("requester-info").innerText = info || "Uzak Cihaz";
    document.getElementById("connection-modal").classList.remove("hidden");
}

function respondConnection(allow) {
    document.getElementById("connection-modal").classList.add("hidden");
    if (isDesktopApp) {
        eel.respond_to_request(allow);
    }
}

function showHostView() {
    document.getElementById("dashboard").classList.add("hidden");
    document.getElementById("host-view").classList.remove("hidden");
}

function on_host_session_ended() {
    document.getElementById("connection-modal").classList.add("hidden");
    document.getElementById("host-view").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    hostMicState = true;
    hostSpkState = true;
    updateBtn("btn-mic-host", true, "Mikrofon");
    updateBtn("btn-spk-host", true, "Hoparlör");
}

function toggleHostMic() {
    hostMicState = !hostMicState;
    updateBtn("btn-mic-host", hostMicState, "Mikrofon");
    if (isDesktopApp) eel.toggle_audio(hostMicState, hostSpkState);
}

function toggleHostSpk() {
    hostSpkState = !hostSpkState;
    updateBtn("btn-spk-host", hostSpkState, "Hoparlör");
    if (isDesktopApp) eel.toggle_audio(hostMicState, hostSpkState);
}

function stopHostSession() {
    if (isDesktopApp) eel.stop_session();
    on_host_session_ended();
}

// --- WEBRTC CLIENT FLOW (Browser, Phone, Tablet & Desktop App) ---
function connectToPeer() {
    const room = document.getElementById("remote-room").value.replace(/[^0-9]/g, "").trim();
    const token = document.getElementById("remote-token").value.trim();

    if (room.length < 6 || token.length < 4) {
        alert("Lütfen geçerli Oda Kodu ve Tek Seferlik Şifre giriniz.");
        return;
    }

    document.getElementById("connect-btn").disabled = true;
    document.getElementById("waiting-text").innerText = "Sinyal sunucusuna bağlanılıyor...";
    document.getElementById("waiting-modal").classList.remove("hidden");

    startMqttSignaling(room, token, 0);
}

function startMqttSignaling(room, token, brokerIdx) {
    if (brokerIdx >= MQTT_BROKERS.length) {
        cleanupClient("Sinyal sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edin.");
        return;
    }

    const brokerUrl = MQTT_BROKERS[brokerIdx];
    const toHostTopic = `yansima/v1/${room}/to-host`;
    const toClientTopic = `yansima/v1/${room}/to-client/${clientId}`;

    let connectedOnce = false;
    mqttClient = mqtt.connect(brokerUrl, {
        connectTimeout: 7000,
        reconnectPeriod: 0
    });

    mqttClient.on("connect", () => {
        connectedOnce = true;
        mqttClient.subscribe(toClientTopic, (err) => {
            if (err) {
                cleanupClient("Sinyal kanalına abone olunamadı.");
                return;
            }
            document.getElementById("waiting-text").innerText = "Karşı tarafın onayı bekleniyor...";
            const deviceLabel = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
                ? "Mobil / Tablet Tarayıcı"
                : "Masaüstü Tarayıcı";
            mqttClient.publish(toHostTopic, JSON.stringify({
                type: "join",
                clientId,
                token,
                device: deviceLabel
            }));
        });
    });

    mqttClient.on("error", () => {
        if (!connectedOnce) {
            try { mqttClient.end(true); } catch {}
            startMqttSignaling(room, token, brokerIdx + 1);
        }
    });

    mqttClient.on("message", async (_topic, payload) => {
        let msg;
        try {
            msg = JSON.parse(payload.toString());
        } catch {
            return;
        }

        if (msg.type === "rejected") {
            cleanupClient(msg.reason || "Bağlantı reddedildi veya tek seferlik şifre geçersiz.");
        } else if (msg.type === "accepted") {
            document.getElementById("waiting-text").innerText = "P2P WebRTC bağlantısı kuruluyor...";
            await initWebRTCClient(toHostTopic, token);
        } else if (msg.type === "answer" && pc) {
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: msg.sdpType || "answer",
                sdp: msg.sdp
            }));
        } else if (msg.type === "ice" && pc && msg.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (e) {
                console.warn("ICE ekleme hatası:", e);
            }
        } else if (msg.type === "bye") {
            cleanupClient("Karşı taraf oturumu sonlandırdı.");
        }
    });
}

async function initWebRTCClient(toHostTopic, token) {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Audio playback element (separate so video autoplay never blocks)
    const remoteVideo = document.getElementById("remote-video");
    const remoteAudio = document.getElementById("remote-audio");

    pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        if (event.track.kind === "video") {
            remoteVideo.srcObject = stream;
            remoteVideo.play().catch(() => {});
            document.getElementById("waiting-modal").classList.add("hidden");
            document.getElementById("dashboard").classList.add("hidden");
            document.getElementById("remote-view").classList.remove("hidden");
        } else if (event.track.kind === "audio") {
            remoteAudio.srcObject = stream;
            remoteAudio.muted = !spkEnabled;
            remoteAudio.play().catch(() => {});
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && mqttClient && mqttClient.connected) {
            mqttClient.publish(toHostTopic, JSON.stringify({
                type: "ice",
                clientId,
                token,
                candidate: event.candidate
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        if (!pc) return;
        const state = pc.connectionState;
        if (state === "connected") {
            if (disconnectGraceTimer) {
                clearTimeout(disconnectGraceTimer);
                disconnectGraceTimer = null;
            }
        } else if (state === "disconnected") {
            if (!disconnectGraceTimer) {
                disconnectGraceTimer = setTimeout(() => {
                    disconnectGraceTimer = null;
                    if (pc && (pc.connectionState === "disconnected" || pc.connectionState === "failed")) {
                        cleanupClient("WebRTC bağlantısı zaman aşımına uğradı.");
                    }
                }, 5000);
            }
        } else if (state === "failed" || state === "closed") {
            cleanupClient("WebRTC bağlantısı kesildi.");
        }
    };

    // DataChannel for mouse, touch, keyboard & cursor sync
    dc = pc.createDataChannel("control", { ordered: true });
    dc.onopen = () => console.log("Kontrol kanalı açıldı.");
    dc.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.startsWith("CURSOR:")) {
            const [nx, ny] = event.data.slice(7).split(",").map(Number);
            if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
                updateRemoteCursor(nx, ny);
            }
        }
    };
    dc.onclose = () => {
        if (pc) {
            setTimeout(() => {
                if (pc && (!dc || dc.readyState === "closed")) {
                    cleanupClient("Bağlantı sonlandı.");
                }
            }, 1500);
        }
    };

    // Request video from host + bidirectional sendrecv audio transceiver
    pc.addTransceiver("video", { direction: "recvonly" });
    const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    audioSender = audioTransceiver.sender;

    try {
        localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        const micTrack = localMicStream.getAudioTracks()[0];
        if (micTrack) {
            micTrack.enabled = micEnabled;
            await audioSender.replaceTrack(micTrack);
        }
    } catch (err) {
        console.warn("Mikrofon erişimi alınamadı:", err);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    mqttClient.publish(toHostTopic, JSON.stringify({
        type: "offer",
        clientId,
        token,
        sdp: offer.sdp,
        sdpType: offer.type
    }));
}

function sendByeSignal() {
    if (mqttClient && mqttClient.connected && document.getElementById("remote-room").value) {
        const room = document.getElementById("remote-room").value.replace(/[^0-9]/g, "").trim();
        const token = document.getElementById("remote-token").value.trim();
        if (room) {
            mqttClient.publish(`yansima/v1/${room}/to-host`, JSON.stringify({ type: "bye", clientId, token }));
        }
    }
}

window.addEventListener("pagehide", sendByeSignal);
window.addEventListener("beforeunload", sendByeSignal);

function cancelConnection() {
    sendByeSignal();
    cleanupClient(null);
}

function disconnect() {
    sendByeSignal();
    cleanupClient(null);
}

function cleanupClient(alertMsg) {
    if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
    }
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    audioSender = null;
    if (localMicStream) {
        localMicStream.getTracks().forEach(t => t.stop());
        localMicStream = null;
    }
    const cursorEl = document.getElementById("remote-cursor");
    if (cursorEl) cursorEl.classList.add("hidden");
    if (mqttClient) { try { mqttClient.end(true); } catch {} mqttClient = null; }

    const remoteVideo = document.getElementById("remote-video");
    const remoteAudio = document.getElementById("remote-audio");
    if (remoteVideo) remoteVideo.srcObject = null;
    if (remoteAudio) remoteAudio.srcObject = null;

    document.getElementById("waiting-modal").classList.add("hidden");
    document.getElementById("remote-view").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    document.getElementById("connect-btn").disabled = false;

    micEnabled = false;
    spkEnabled = true;
    rightClickMode = false;
    updateBtn("btn-mic", false, "Mikrofon");
    updateBtn("btn-spk", true, "Hoparlör");
    updateBtn("btn-rclick", false, "Sağ Tık");

    if (alertMsg) alert(alertMsg);
}

// --- CLIENT TOOLBAR CONTROLS ---
async function toggleMic() {
    const nextState = !micEnabled;
    if (nextState && !localMicStream) {
        try {
            localMicStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            const micTrack = localMicStream.getAudioTracks()[0];
            if (micTrack && audioSender) {
                await audioSender.replaceTrack(micTrack);
            }
        } catch (err) {
            console.warn("Mikrofon izni alınamadı:", err);
            micEnabled = false;
            updateBtn("btn-mic", false, "Mikrofon");
            alert("Mikrofon izni verilmedi veya mikrofon bulunamadı.");
            return;
        }
    }
    micEnabled = nextState;
    if (localMicStream) {
        localMicStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    }
    updateBtn("btn-mic", micEnabled, "Mikrofon");
}

function toggleSpk() {
    spkEnabled = !spkEnabled;
    const remoteAudio = document.getElementById("remote-audio");
    if (remoteAudio) {
        remoteAudio.muted = !spkEnabled;
        if (spkEnabled && remoteAudio.srcObject) {
            remoteAudio.play().catch(() => {});
        }
    }
    updateBtn("btn-spk", spkEnabled, "Hoparlör");
}

function toggleRightClickMode() {
    rightClickMode = !rightClickMode;
    const btn = document.getElementById("btn-rclick");
    updateBtn("btn-rclick", rightClickMode, "Sağ Tık");
    if (btn) btn.classList.toggle("active-toggle", rightClickMode);
}

function focusMobileKeyboard() {
    const kb = document.getElementById("mobile-kb-input");
    kb.focus();
}

function toggleFullscreen() {
    const el = document.getElementById("remote-view");
    if (!document.fullscreenElement) {
        el.requestFullscreen?.().catch(() => {});
    } else {
        document.exitFullscreen?.().catch(() => {});
    }
}

function updateBtn(id, state, label) {
    const btn = document.getElementById(id);
    if (btn) {
        btn.innerText = `${label}: ${state ? "Açık" : "Kapalı"}`;
        btn.style.opacity = state ? "1" : "0.75";
        btn.classList.toggle("active-toggle", state);
    }
}

// --- COORDINATE & INPUT MAPPING (MOUSE, TOUCH, KEYBOARD) ---
function sendControl(cmd) {
    if (dc && dc.readyState === "open") {
        dc.send(cmd);
    }
}

function getNormalizedCoords(clientX, clientY, videoEl) {
    const rect = videoEl.getBoundingClientRect();
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(rect.width / vw, rect.height / vh);
    const displayW = vw * scale;
    const displayH = vh * scale;
    const offsetX = (rect.width - displayW) / 2;
    const offsetY = (rect.height - displayH) / 2;

    const lx = clientX - rect.left;
    const ly = clientY - rect.top;

    if (lx < offsetX || lx > offsetX + displayW || ly < offsetY || ly > offsetY + displayH) {
        return null;
    }

    return {
        x: ((lx - offsetX) / displayW).toFixed(4),
        y: ((ly - offsetY) / displayH).toFixed(4)
    };
}

function updateRemoteCursor(nx, ny) {
    const cursorEl = document.getElementById("remote-cursor");
    const videoEl = document.getElementById("remote-video");
    const wrapperEl = document.getElementById("video-wrapper");
    if (!cursorEl || !videoEl || !wrapperEl || !videoEl.videoWidth || !videoEl.videoHeight) return;

    const vRect = videoEl.getBoundingClientRect();
    const wRect = wrapperEl.getBoundingClientRect();
    const scale = Math.min(vRect.width / videoEl.videoWidth, vRect.height / videoEl.videoHeight);
    const displayW = videoEl.videoWidth * scale;
    const displayH = videoEl.videoHeight * scale;
    const offsetX = (vRect.left - wRect.left) + (vRect.width - displayW) / 2;
    const offsetY = (vRect.top - wRect.top) + (vRect.height - displayH) / 2;

    const px = offsetX + Math.max(0, Math.min(1, nx)) * displayW;
    const py = offsetY + Math.max(0, Math.min(1, ny)) * displayH;

    cursorEl.classList.remove("hidden");
    cursorEl.style.transform = `translate3d(${px - 3}px, ${py - 2}px, 0)`;
}

const remoteVideo = document.getElementById("remote-video");
let moveRafPending = false;

remoteVideo.addEventListener("mousemove", (e) => {
    if (moveRafPending) return;
    moveRafPending = true;
    requestAnimationFrame(() => {
        const coords = getNormalizedCoords(e.clientX, e.clientY, remoteVideo);
        if (coords) {
            updateRemoteCursor(Number(coords.x), Number(coords.y));
            sendControl(`MOVE:${coords.x},${coords.y}`);
        }
        moveRafPending = false;
    });
});

remoteVideo.addEventListener("mousedown", (e) => {
    const coords = getNormalizedCoords(e.clientX, e.clientY, remoteVideo);
    if (!coords) return;
    const btn = e.button === 2 ? "right" : (e.button === 1 ? "middle" : "left");
    sendControl(`MDOWN:${btn},${coords.x},${coords.y}`);
});

remoteVideo.addEventListener("mouseup", (e) => {
    const coords = getNormalizedCoords(e.clientX, e.clientY, remoteVideo);
    if (!coords) return;
    const btn = e.button === 2 ? "right" : (e.button === 1 ? "middle" : "left");
    sendControl(`MUP:${btn},${coords.x},${coords.y}`);
});

remoteVideo.addEventListener("contextmenu", (e) => e.preventDefault());

remoteVideo.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dy = e.deltaY > 0 ? -120 : 120;
    sendControl(`SCROLL:0,${dy}`);
}, { passive: false });

// Touch support for Phones & Tablets
let touchStartInfo = null;
let longPressTimer = null;
let twoFingerLastY = null;

function ensureRemoteAudioPlaying() {
    const remoteAudio = document.getElementById("remote-audio");
    if (remoteAudio && spkEnabled && remoteAudio.paused && remoteAudio.srcObject) {
        remoteAudio.play().catch(() => {});
    }
}

remoteVideo.addEventListener("touchstart", (e) => {
    e.preventDefault();
    ensureRemoteAudioPlaying();
    if (e.touches.length === 2) {
        clearTimeout(longPressTimer);
        twoFingerLastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        return;
    }
    if (e.touches.length === 1) {
        const t = e.touches[0];
        const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
        touchStartInfo = { x: t.clientX, y: t.clientY, moved: false, longPressed: false };
        if (coords) {
            updateRemoteCursor(Number(coords.x), Number(coords.y));
            sendControl(`MOVE:${coords.x},${coords.y}`);
        }

        longPressTimer = setTimeout(() => {
            if (touchStartInfo && !touchStartInfo.moved) {
                touchStartInfo.longPressed = true;
                const c = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
                if (c) sendControl(`RCLICK:${c.x},${c.y}`);
            }
        }, 500);
    }
}, { passive: false });

remoteVideo.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && twoFingerLastY !== null) {
        const avgY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const diff = avgY - twoFingerLastY;
        if (Math.abs(diff) > 15) {
            sendControl(`SCROLL:0,${diff > 0 ? 120 : -120}`);
            twoFingerLastY = avgY;
        }
        return;
    }
    if (e.touches.length === 1 && touchStartInfo) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - touchStartInfo.x, t.clientY - touchStartInfo.y) > 8) {
            touchStartInfo.moved = true;
            clearTimeout(longPressTimer);
        }
        const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
        if (coords) {
            updateRemoteCursor(Number(coords.x), Number(coords.y));
            sendControl(`MOVE:${coords.x},${coords.y}`);
        }
    }
}, { passive: false });

remoteVideo.addEventListener("touchend", (e) => {
    e.preventDefault();
    clearTimeout(longPressTimer);
    twoFingerLastY = null;
    if (touchStartInfo && !touchStartInfo.moved && !touchStartInfo.longPressed && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
        if (coords) {
            sendControl(`${rightClickMode ? "RCLICK" : "CLICK"}:${coords.x},${coords.y}`);
        }
    }
    touchStartInfo = null;
}, { passive: false });

// Desktop Keyboard Events
window.addEventListener("keydown", (e) => {
    if (document.getElementById("remote-view").classList.contains("hidden")) return;
    if (document.activeElement && document.activeElement.id === "mobile-kb-input") return;
    if (["Tab", "Alt", "F5", "F11", "F12"].includes(e.key)) e.preventDefault();
    sendControl(`KDOWN:${e.key}`);
});

window.addEventListener("keyup", (e) => {
    if (document.getElementById("remote-view").classList.contains("hidden")) return;
    if (document.activeElement && document.activeElement.id === "mobile-kb-input") return;
    if (["Tab", "Alt", "F5", "F11", "F12"].includes(e.key)) e.preventDefault();
    sendControl(`KUP:${e.key}`);
});

// Mobile Virtual Keyboard Events
const mobileKb = document.getElementById("mobile-kb-input");
mobileKb.addEventListener("input", (e) => {
    const val = mobileKb.value;
    if (val) {
        sendControl(`TEXT:${val}`);
        mobileKb.value = "";
    }
});
mobileKb.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" || e.key === "Enter") {
        sendControl(`KDOWN:${e.key}`);
        sendControl(`KUP:${e.key}`);
    }
});
