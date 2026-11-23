const isDesktopApp = (typeof eel !== "undefined" && !window.__NO_EEL__);
const isAndroidApp = Boolean(window.AndroidBridge) || Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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

let pendingIceCandidates = [];
let remoteDescApplied = false;

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
let trackpadMode = isAndroidApp;
let kbOpen = false;
let isLandscapeLocked = false;
let isFullscreenMode = false;
let zoomScale = 1;
let panX = 0;
let panY = 0;
let cursorNx = 0.5;
let cursorNy = 0.5;
let lastLocalCursorTs = 0;
let hostMicState = true;
let hostSpkState = true;
let hostCtrlState = true;
let hostPrivacyState = false;
let clientPrivacyState = false;
let clientChatUnread = 0;
let clientReadOnly = false;

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
            const monitors = await eel.get_monitors()();
            populateMonitorSelects(monitors);
            const autoStart = await eel.get_autostart()();
            const chk = document.getElementById("chk-autostart");
            if (chk) chk.checked = Boolean(autoStart);
        } catch (e) {
            console.error("Eel init hatası:", e);
        }
    } else {
        hostCard.classList.add("hidden");
        modeBadge.innerText = isAndroidApp ? "Android Uygulaması" : "Tarayıcı / Mobil İstemci";
        setStatus(true, "Bağlanmaya Hazır");
    }

    if (isAndroidApp) {
        const tmBtn = document.getElementById("btn-touchmode");
        if (tmBtn) tmBtn.classList.add("hidden");
        const qrBtn = document.getElementById("qr-scan-btn");
        if (qrBtn) qrBtn.classList.remove("hidden");
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
    eel.expose(on_host_chat_message);
    eel.expose(on_host_privacy_state);
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
    const fullLink = `${base}${sep}room=${cleanRoom}&token=${currentToken}`;
    document.getElementById("invite-link").value = fullLink;

    const qrBox = document.getElementById("invite-qr");
    if (qrBox && typeof QRCode !== "undefined" && cleanRoom && currentToken) {
        qrBox.innerHTML = "";
        new QRCode(qrBox, {
            text: fullLink,
            width: 84,
            height: 84,
            colorDark: "#111111",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

function toggleAutostart(enabled) {
    if (isDesktopApp) {
        eel.set_autostart(Boolean(enabled));
    }
}

function applyAudioSource() {
    if (!isDesktopApp) return;
    const src = document.getElementById("live-audio-source")?.value || "both";
    eel.set_audio_source(src);
}

function hostSendFile() {
    if (isDesktopApp) {
        eel.host_send_file();
    }
}

async function regenerateInvite() {
    if (isDesktopApp) {
        try {
            const info = await eel.regenerate_invite()();
            if (info && info.token) {
                update_invite_ui(info.room, info.token);
            }
        } catch (e) {
            console.error("Yenileme hatası:", e);
        }
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

function populateMonitorSelects(monitors) {
    if (!Array.isArray(monitors) || !monitors.length) return;
    ["host-monitor", "live-monitor"].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = "";
        monitors.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m.index;
            opt.textContent = m.label;
            sel.appendChild(opt);
        });
    });
}

function applyHostStreamSettings() {
    if (!isDesktopApp) return;
    const mon = document.getElementById("host-monitor")?.value || 1;
    const qual = document.getElementById("host-quality")?.value || "high";
    const liveMon = document.getElementById("live-monitor");
    const liveQual = document.getElementById("live-quality");
    if (liveMon) liveMon.value = mon;
    if (liveQual) liveQual.value = qual;
    eel.set_stream_settings(mon, qual);
}

function applyLiveStreamSettings() {
    if (!isDesktopApp) return;
    const mon = document.getElementById("live-monitor")?.value || 1;
    const qual = document.getElementById("live-quality")?.value || "high";
    const hostMon = document.getElementById("host-monitor");
    const hostQual = document.getElementById("host-quality");
    if (hostMon) hostMon.value = mon;
    if (hostQual) hostQual.value = qual;
    eel.set_stream_settings(mon, qual);
}

// --- HOST UI HANDLERS ---
function show_connection_request(info) {
    document.getElementById("requester-info").innerText = info || "Uzak Cihaz";
    document.getElementById("connection-modal").classList.remove("hidden");
}

function respondConnection(allow, controlAllowed = true) {
    document.getElementById("connection-modal").classList.add("hidden");
    if (allow) {
        hostCtrlState = Boolean(controlAllowed);
        updateBtn("btn-ctrl-host", hostCtrlState, "Kontrol");
    }
    if (isDesktopApp) {
        eel.respond_to_request(allow, controlAllowed);
    }
}

function toggleHostControl() {
    hostCtrlState = !hostCtrlState;
    updateBtn("btn-ctrl-host", hostCtrlState, "Kontrol");
    if (isDesktopApp) eel.set_control_mode(hostCtrlState);
}

function showHostView() {
    document.getElementById("dashboard").classList.add("hidden");
    document.getElementById("host-view").classList.remove("hidden");
}

async function on_host_session_ended() {
    document.getElementById("connection-modal").classList.add("hidden");
    document.getElementById("host-view").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    hostMicState = true;
    hostSpkState = true;
    hostCtrlState = true;
    hostPrivacyState = false;
    updateBtn("btn-mic-host", true, "Mikrofon");
    updateBtn("btn-spk-host", true, "Hoparlör");
    updateBtn("btn-ctrl-host", true, "Kontrol");
    const privBtn = document.getElementById("btn-privacy-host");
    if (privBtn) {
        privBtn.innerText = "Perde: Kapalı";
        privBtn.classList.remove("active-toggle");
    }
    const hChat = document.getElementById("host-chat-messages");
    if (hChat) hChat.innerHTML = "";
    if (isDesktopApp) {
        try {
            const info = await eel.get_invite_info()();
            if (info && info.token) {
                update_invite_ui(info.room, info.token);
            }
        } catch {}
    }
}

function toggleHostPrivacy() {
    hostPrivacyState = !hostPrivacyState;
    on_host_privacy_state(hostPrivacyState);
    if (isDesktopApp) eel.set_privacy_screen(hostPrivacyState);
}

function on_host_privacy_state(enabled) {
    hostPrivacyState = Boolean(enabled);
    const btn = document.getElementById("btn-privacy-host");
    if (btn) {
        btn.innerText = hostPrivacyState ? "Perde: Açık" : "Perde: Kapalı";
        btn.classList.toggle("active-toggle", hostPrivacyState);
    }
}

function appendChatMessage(containerId, sender, text, isSelf) {
    const box = document.getElementById(containerId);
    if (!box) return;
    const div = document.createElement("div");
    div.className = `chat-msg ${isSelf ? "self" : "peer"}`;
    div.textContent = `${isSelf ? "Ben" : sender}: ${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function on_host_chat_message(sender, text) {
    appendChatMessage("host-chat-messages", sender, text, false);
}

function sendHostChat() {
    const inp = document.getElementById("host-chat-input");
    if (!inp) return;
    const txt = inp.value.trim();
    if (!txt) return;
    inp.value = "";
    appendChatMessage("host-chat-messages", "Ben", txt, true);
    if (isDesktopApp) eel.host_send_chat(txt);
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
            document.getElementById("waiting-text").innerText = "Bağlantı Kuruluyor...";
            await initWebRTCClient(toHostTopic, token);
        } else if (msg.type === "answer" && pc) {
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: msg.sdpType || "answer",
                sdp: msg.sdp
            }));
            remoteDescApplied = true;
            while (pendingIceCandidates.length > 0) {
                const c = pendingIceCandidates.shift();
                try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
            }
        } else if (msg.type === "ice" && pc && msg.candidate) {
            if (!remoteDescApplied) {
                pendingIceCandidates.push(msg.candidate);
            } else {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                } catch (e) {
                    console.warn("ICE ekleme hatası:", e);
                }
            }
        } else if (msg.type === "bye") {
            cleanupClient("Karşı taraf oturumu sonlandırdı.");
        }
    });
}

async function initWebRTCClient(toHostTopic, token) {
    pendingIceCandidates = [];
    remoteDescApplied = false;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });

    // Audio playback element (separate so video autoplay never blocks)
    const remoteVideo = document.getElementById("remote-video");
    const remoteAudio = document.getElementById("remote-audio");
    const loadingOverlay = document.getElementById("video-loading-overlay");

    remoteVideo.onloadeddata = () => {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
    };
    remoteVideo.onplaying = () => {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
    };

    pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        if (event.track.kind === "video") {
            document.getElementById("waiting-modal").classList.add("hidden");
            document.getElementById("dashboard").classList.add("hidden");
            document.getElementById("remote-view").classList.remove("hidden");
            if (loadingOverlay) loadingOverlay.classList.remove("hidden");

            remoteVideo.srcObject = stream;
            remoteVideo.muted = true;
            remoteVideo.play().catch(() => {});
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
            const rv = document.getElementById("remote-video");
            if (rv && rv.paused && rv.srcObject) {
                rv.play().catch(() => {});
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
    const incomingClientFiles = {};

    dc.onmessage = async (event) => {
        if (typeof event.data !== "string") return;
        if (event.data.startsWith("CURSOR:")) {
            if (Date.now() - lastLocalCursorTs < 350) return;
            const [nx, ny] = event.data.slice(7).split(",").map(Number);
            if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
                updateRemoteCursor(nx, ny);
            }
        } else if (event.data.startsWith("MODE:")) {
            clientReadOnly = event.data.slice(5) === "readonly";
            const badge = document.querySelector(".conn-badge");
            if (badge) {
                badge.innerText = clientReadOnly ? "Salt Okunur" : "Canlı";
                badge.style.color = clientReadOnly ? "#f0ad4e" : "#4caf50";
            }
        } else if (event.data.startsWith("CLIP_DATA:")) {
            try {
                const b64 = event.data.slice(10);
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const text = new TextDecoder().decode(bytes);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                }
                alert("PC panosu kopyalandı.");
            } catch {
                alert("Pano okunamadı.");
            }
        } else if (event.data.startsWith("FILE_START:")) {
            const parts = event.data.slice(11).split(":");
            const fid = parts[0];
            const fname = parts[1] || "dosya";
            incomingClientFiles[fid] = { name: fname, chunks: [] };
        } else if (event.data.startsWith("FILE_CHUNK:")) {
            const rest = event.data.slice(11);
            const sep = rest.indexOf(":");
            if (sep > 0) {
                const fid = rest.slice(0, sep);
                const b64 = rest.slice(sep + 1);
                const entry = incomingClientFiles[fid];
                if (entry) {
                    entry.chunks.push(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
                }
            }
        } else if (event.data.startsWith("FILE_END:")) {
            const fid = event.data.slice(9);
            const entry = incomingClientFiles[fid];
            delete incomingClientFiles[fid];
            if (entry) {
                const blob = new Blob(entry.chunks);
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = entry.name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
        } else if (event.data.startsWith("CHAT:")) {
            try {
                const b64 = event.data.slice(5);
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const text = new TextDecoder().decode(bytes);
                appendChatMessage("client-chat-messages", "PC", text, false);
                const panel = document.getElementById("client-chat-box");
                if (panel && panel.classList.contains("hidden")) {
                    clientChatUnread++;
                    const badge = document.getElementById("chat-unread-badge");
                    if (badge) {
                        badge.innerText = clientChatUnread;
                        badge.classList.remove("hidden");
                    }
                }
            } catch {}
        } else if (event.data.startsWith("PRIVACY:")) {
            clientPrivacyState = event.data.slice(8) === "on";
            const btn = document.getElementById("btn-privacy-client");
            if (btn) btn.classList.toggle("active-toggle", clientPrivacyState);
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

    // Wait briefly (up to 1.2s) for STUN srflx candidates so offer.sdp includes them directly
    await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, 1200);
        const onGather = () => {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                pc.removeEventListener("icegatheringstatechange", onGather);
                resolve();
            }
        };
        pc.addEventListener("icegatheringstatechange", onGather);
    });

    mqttClient.publish(toHostTopic, JSON.stringify({
        type: "offer",
        clientId,
        token,
        sdp: pc.localDescription.sdp,
        sdpType: pc.localDescription.type
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
    pendingIceCandidates = [];
    remoteDescApplied = false;
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

    document.getElementById("shortcut-drawer")?.classList.add("hidden");
    document.getElementById("btn-shortcuts")?.classList.remove("active-toggle");
    document.getElementById("client-chat-box")?.classList.add("hidden");
    document.getElementById("btn-chat")?.classList.remove("active-toggle");
    const cMsgs = document.getElementById("client-chat-messages");
    if (cMsgs) cMsgs.innerHTML = "";
    clientChatUnread = 0;
    document.getElementById("chat-unread-badge")?.classList.add("hidden");
    clientPrivacyState = false;
    document.getElementById("btn-privacy-client")?.classList.remove("active-toggle");
    clientReadOnly = false;
    const badge = document.querySelector(".conn-badge");
    if (badge) {
        badge.innerText = "Canlı";
        badge.style.color = "#4caf50";
    }
    micEnabled = false;
    spkEnabled = true;
    rightClickMode = false;
    trackpadMode = isAndroidApp;
    kbOpen = false;
    isLandscapeLocked = false;
    isFullscreenMode = false;
    document.getElementById("remote-view")?.classList.remove("fullscreen-active");
    document.getElementById("btn-exit-fs")?.classList.add("hidden");
    if (window.AndroidBridge && window.AndroidBridge.setFullscreen) {
        window.AndroidBridge.setFullscreen(false);
    }
    resetZoom();
    updateBtn("btn-mic", false, "Mikrofon");
    updateBtn("btn-spk", true, "Hoparlör");
    updateBtn("btn-rclick", false, "Sağ Tık");
    const tmBtn = document.getElementById("btn-touchmode");
    if (tmBtn) {
        tmBtn.innerText = "Fare: Dokunmatik";
        tmBtn.classList.remove("active-toggle");
    }
    const kbBtn = document.getElementById("btn-kb");
    if (kbBtn) kbBtn.classList.remove("active-toggle");
    const rotBtn = document.getElementById("btn-rotate");
    if (rotBtn) {
        rotBtn.innerText = "Yatay";
        rotBtn.classList.remove("active-toggle");
    }
    if (window.AndroidBridge && window.AndroidBridge.setOrientation) {
        window.AndroidBridge.setOrientation("auto");
    } else if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch {}
    }

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
            document.getElementById("shortcut-drawer")?.classList.add("hidden");
    document.getElementById("btn-shortcuts")?.classList.remove("active-toggle");
    document.getElementById("client-chat-box")?.classList.add("hidden");
    document.getElementById("btn-chat")?.classList.remove("active-toggle");
    const cMsgs = document.getElementById("client-chat-messages");
    if (cMsgs) cMsgs.innerHTML = "";
    clientChatUnread = 0;
    document.getElementById("chat-unread-badge")?.classList.add("hidden");
    clientPrivacyState = false;
    document.getElementById("btn-privacy-client")?.classList.remove("active-toggle");
    clientReadOnly = false;
    const badge = document.querySelector(".conn-badge");
    if (badge) {
        badge.innerText = "Canlı";
        badge.style.color = "#4caf50";
    }
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

function toggleTouchMode() {
    trackpadMode = !trackpadMode;
    const btn = document.getElementById("btn-touchmode");
    if (btn) {
        btn.innerText = trackpadMode ? "Fare: Trackpad" : "Fare: Dokunmatik";
        btn.classList.toggle("active-toggle", trackpadMode);
    }
}

function toggleClientChat() {
    const panel = document.getElementById("client-chat-box");
    const btn = document.getElementById("btn-chat");
    if (!panel) return;
    const willOpen = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !willOpen);
    if (btn) btn.classList.toggle("active-toggle", willOpen);
    if (willOpen) {
        clientChatUnread = 0;
        const badge = document.getElementById("chat-unread-badge");
        if (badge) badge.classList.add("hidden");
        document.getElementById("client-chat-input")?.focus();
    }
}

function sendClientChat() {
    const inp = document.getElementById("client-chat-input");
    if (!inp) return;
    const txt = inp.value.trim();
    if (!txt) return;
    inp.value = "";
    appendChatMessage("client-chat-messages", "Ben", txt, true);
    const bytes = new TextEncoder().encode(txt);
    let bin = "";
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    sendControl(`CHAT:${btoa(bin)}`);
}

function toggleClientPrivacy() {
    if (clientReadOnly) {
        alert("Salt okunur moddasınız.");
        return;
    }
    clientPrivacyState = !clientPrivacyState;
    const btn = document.getElementById("btn-privacy-client");
    if (btn) btn.classList.toggle("active-toggle", clientPrivacyState);
    sendControl(`PRIVACY:${clientPrivacyState ? "on" : "off"}`);
}

function toggleShortcutsDrawer() {
    const drawer = document.getElementById("shortcut-drawer");
    const btn = document.getElementById("btn-shortcuts");
    if (!drawer) return;
    const willOpen = drawer.classList.contains("hidden");
    drawer.classList.toggle("hidden", !willOpen);
    if (btn) btn.classList.toggle("active-toggle", willOpen);
}

function sendCombo(combo) {
    if (clientReadOnly) {
        alert("Salt okunur moddasınız.");
        return;
    }
    sendControl(`COMBO:${combo}`);
}

async function sendClipboardToHost() {
    try {
        let text = "";
        if (navigator.clipboard && navigator.clipboard.readText) {
            text = await navigator.clipboard.readText();
        }
        if (!text) {
            text = prompt("PC'ye gönderilecek metni yapıştırın:") || "";
        }
        if (!text) return;
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        sendControl(`CLIP_SET:${btoa(bin)}`);
    } catch {
        const text = prompt("PC'ye gönderilecek metni yapıştırın:") || "";
        if (!text) return;
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        sendControl(`CLIP_SET:${btoa(bin)}`);
    }
}

function requestClipboardFromHost() {
    sendControl("CLIP_GET");
}

function triggerClientFileUpload() {
    const inp = document.getElementById("client-file-input");
    if (inp) {
        inp.value = "";
        inp.click();
    }
}

async function handleClientFileSelected(input) {
    const file = input.files && input.files[0];
    if (!file || !dc || dc.readyState !== "open") return;
    const fid = Math.random().toString(36).slice(2, 10);
    const safeName = file.name.replace(/:/g, "_");
    sendControl(`FILE_START:${fid}:${safeName}:${file.size}`);
    const chunkSize = 24576;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
        const buf = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        sendControl(`FILE_CHUNK:${fid}:${btoa(bin)}`);
        await new Promise(r => setTimeout(r, 5));
    }
    sendControl(`FILE_END:${fid}`);
    alert(`Dosya gönderildi: ${file.name}`);
}

let qrStream = null;
let qrTimer = null;

async function openQrScanner() {
    const modal = document.getElementById("qr-modal");
    const video = document.getElementById("qr-video");
    const canvas = document.getElementById("qr-canvas");
    if (!modal || !video) return;

    try {
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = qrStream;
        await video.play();
        modal.classList.remove("hidden");

        const detector = ("BarcodeDetector" in window) ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
        qrTimer = setInterval(async () => {
            if (!video.videoWidth || !video.videoHeight) return;
            try {
                let rawValue = null;
                if (detector) {
                    const codes = await detector.detect(video);
                    if (codes.length > 0) rawValue = codes[0].rawValue;
                } else if (typeof jsQR !== "undefined" && canvas) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(imgData.data, imgData.width, imgData.height);
                    if (code) rawValue = code.data;
                }
                if (rawValue) {
                    const url = new URL(rawValue);
                    const r = url.searchParams.get("room");
                    const t = url.searchParams.get("token");
                    if (r && t) {
                        closeQrScanner();
                        document.getElementById("remote-room").value = r;
                        document.getElementById("remote-token").value = t;
                        connectToPeer();
                    }
                }
            } catch {}
        }, 180);
    } catch {
        alert("Kamera izni alınamadı veya kamera bulunamadı.");
    }
}

function closeQrScanner() {
    if (qrTimer) {
        clearInterval(qrTimer);
        qrTimer = null;
    }
    if (qrStream) {
        qrStream.getTracks().forEach(t => t.stop());
        qrStream = null;
    }
    const video = document.getElementById("qr-video");
    if (video) video.srcObject = null;
    document.getElementById("qr-modal")?.classList.add("hidden");
}

function toggleMobileKeyboard() {
    const kb = document.getElementById("mobile-kb-input");
    const btn = document.getElementById("btn-kb");
    if (kbOpen || document.activeElement === kb) {
        kb.blur();
        kbOpen = false;
        if (btn) btn.classList.remove("active-toggle");
    } else {
        kb.focus();
        kbOpen = true;
        if (btn) btn.classList.add("active-toggle");
    }
}

function applyVideoTransform() {
    const videoEl = document.getElementById("remote-video");
    const wrapperEl = document.getElementById("video-wrapper");
    if (!videoEl || !wrapperEl) return;

    if (zoomScale <= 1.01) {
        zoomScale = 1;
        panX = 0;
        panY = 0;
    } else {
        const wRect = wrapperEl.getBoundingClientRect();
        const maxPanX = ((zoomScale - 1) * wRect.width) / 2;
        const maxPanY = ((zoomScale - 1) * wRect.height) / 2;
        panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
        panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
    }

    videoEl.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`;

    const zoomBtn = document.getElementById("btn-zoom");
    if (zoomBtn) {
        zoomBtn.innerText = `Yakınlaştır: ${zoomScale.toFixed(1).replace(".0", "")}x`;
        zoomBtn.classList.toggle("active-toggle", zoomScale > 1.01);
    }
    updateRemoteCursor(cursorNx, cursorNy);
}

function resetZoom() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    applyVideoTransform();
}

function toggleZoomReset() {
    if (zoomScale > 1.05) {
        resetZoom();
    } else {
        zoomScale = 2;
        panX = 0;
        panY = 0;
        applyVideoTransform();
    }
}

async function toggleOrientation() {
    isLandscapeLocked = !isLandscapeLocked;
    const btn = document.getElementById("btn-rotate");
    if (btn) {
        btn.innerText = isLandscapeLocked ? "Yön: Yatay" : "Yatay";
        btn.classList.toggle("active-toggle", isLandscapeLocked);
    }
    if (window.AndroidBridge && window.AndroidBridge.setOrientation) {
        window.AndroidBridge.setOrientation(isLandscapeLocked ? "landscape" : "auto");
    } else if (screen.orientation) {
        try {
            if (isLandscapeLocked && screen.orientation.lock) {
                await screen.orientation.lock("landscape");
            } else if (!isLandscapeLocked && screen.orientation.unlock) {
                screen.orientation.unlock();
            }
        } catch {}
    }
    setTimeout(() => applyVideoTransform(), 250);
}

function toggleFullscreen() {
    const el = document.getElementById("remote-view");
    const exitBtn = document.getElementById("btn-exit-fs");
    isFullscreenMode = !isFullscreenMode;

    if (el) el.classList.toggle("fullscreen-active", isFullscreenMode);
    if (exitBtn) exitBtn.classList.toggle("hidden", !isFullscreenMode);

    if (window.AndroidBridge && window.AndroidBridge.setFullscreen) {
        window.AndroidBridge.setFullscreen(isFullscreenMode);
    } else {
        if (isFullscreenMode && !document.fullscreenElement) {
            el?.requestFullscreen?.().catch(() => {});
        } else if (!isFullscreenMode && document.fullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
        }
    }
    setTimeout(() => applyVideoTransform(), 200);
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
    cursorNx = Math.max(0, Math.min(1, nx));
    cursorNy = Math.max(0, Math.min(1, ny));

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

    const px = offsetX + cursorNx * displayW;
    const py = offsetY + cursorNy * displayH;

    cursorEl.classList.remove("hidden");
    cursorEl.style.transform = `translate3d(${px - 3}px, ${py - 2}px, 0)`;
}

window.addEventListener("resize", () => updateRemoteCursor(cursorNx, cursorNy));
window.addEventListener("orientationchange", () => setTimeout(() => applyVideoTransform(), 250));

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

// Touch support for Phones & Tablets (Direct + Trackpad + Pinch-Zoom/Pan)
let touchStartInfo = null;
let longPressTimer = null;
let twoFingerState = null;

function ensureRemoteAudioPlaying() {
    const remoteVideo = document.getElementById("remote-video");
    if (remoteVideo && remoteVideo.paused && remoteVideo.srcObject) {
        remoteVideo.play().catch(() => {});
    }
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
        touchStartInfo = null;
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        twoFingerState = {
            startDist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
            startScale: zoomScale,
            lastMidX: (t0.clientX + t1.clientX) / 2,
            lastMidY: (t0.clientY + t1.clientY) / 2,
            isPinching: zoomScale > 1.02
        };
        return;
    }
    if (e.touches.length === 1) {
        const t = e.touches[0];
        touchStartInfo = {
            startX: t.clientX,
            startY: t.clientY,
            lastX: t.clientX,
            lastY: t.clientY,
            moved: false,
            longPressed: false
        };

        if (!trackpadMode) {
            const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
            if (coords) {
                updateRemoteCursor(Number(coords.x), Number(coords.y));
                sendControl(`MOVE:${coords.x},${coords.y}`);
            }
        }

        longPressTimer = setTimeout(() => {
            if (touchStartInfo && !touchStartInfo.moved) {
                touchStartInfo.longPressed = true;
                if (trackpadMode) {
                    sendControl(`RCLICK:${cursorNx.toFixed(4)},${cursorNy.toFixed(4)}`);
                } else {
                    const c = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
                    if (c) sendControl(`RCLICK:${c.x},${c.y}`);
                }
            }
        }, 500);
    }
}, { passive: false });

let touchMoveRafPending = false;
let pendingMoveCmd = null;

function queueMoveControl(nx, ny) {
    lastLocalCursorTs = Date.now();
    pendingMoveCmd = `MOVE:${nx.toFixed(4)},${ny.toFixed(4)}`;
    if (touchMoveRafPending) return;
    touchMoveRafPending = true;
    requestAnimationFrame(() => {
        if (pendingMoveCmd) {
            sendControl(pendingMoveCmd);
            pendingMoveCmd = null;
        }
        touchMoveRafPending = false;
    });
}

remoteVideo.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && twoFingerState) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const midX = (t0.clientX + t1.clientX) / 2;
        const midY = (t0.clientY + t1.clientY) / 2;

        if (Math.abs(dist - twoFingerState.startDist) > 12) {
            twoFingerState.isPinching = true;
        }

        if (twoFingerState.isPinching || zoomScale > 1.02) {
            const ratio = twoFingerState.startDist > 0 ? dist / twoFingerState.startDist : 1;
            zoomScale = Math.max(1, Math.min(4, twoFingerState.startScale * ratio));
            panX += (midX - twoFingerState.lastMidX);
            panY += (midY - twoFingerState.lastMidY);
            twoFingerState.lastMidX = midX;
            twoFingerState.lastMidY = midY;
            applyVideoTransform();
        } else {
            const diffY = midY - twoFingerState.lastMidY;
            if (Math.abs(diffY) > 15) {
                sendControl(`SCROLL:0,${diffY > 0 ? 120 : -120}`);
                twoFingerState.lastMidY = midY;
            }
        }
        return;
    }
    if (e.touches.length === 1 && touchStartInfo) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - touchStartInfo.startX, t.clientY - touchStartInfo.startY) > 6) {
            touchStartInfo.moved = true;
            clearTimeout(longPressTimer);
        }

        if (trackpadMode) {
            const rect = remoteVideo.getBoundingClientRect();
            const dx = t.clientX - touchStartInfo.lastX;
            const dy = t.clientY - touchStartInfo.lastY;
            touchStartInfo.lastX = t.clientX;
            touchStartInfo.lastY = t.clientY;
            if (rect.width > 0 && rect.height > 0) {
                const sensitivity = 1.45;
                const nextX = Math.max(0, Math.min(1, cursorNx + (dx * sensitivity) / rect.width));
                const nextY = Math.max(0, Math.min(1, cursorNy + (dy * sensitivity) / rect.height));
                updateRemoteCursor(nextX, nextY);
                queueMoveControl(nextX, nextY);
            }
        } else {
            const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
            if (coords) {
                const nx = Number(coords.x);
                const ny = Number(coords.y);
                updateRemoteCursor(nx, ny);
                queueMoveControl(nx, ny);
            }
        }
    }
}, { passive: false });

remoteVideo.addEventListener("touchend", (e) => {
    e.preventDefault();
    clearTimeout(longPressTimer);
    if (e.touches.length < 2) {
        twoFingerState = null;
    }
    if (touchStartInfo && !touchStartInfo.moved && !touchStartInfo.longPressed && e.changedTouches.length === 1) {
        if (trackpadMode) {
            sendControl(`${rightClickMode ? "RCLICK" : "CLICK"}:${cursorNx.toFixed(4)},${cursorNy.toFixed(4)}`);
        } else {
            const t = e.changedTouches[0];
            const coords = getNormalizedCoords(t.clientX, t.clientY, remoteVideo);
            if (coords) {
                sendControl(`${rightClickMode ? "RCLICK" : "CLICK"}:${coords.x},${coords.y}`);
            }
        }
    }
    if (e.touches.length === 0) {
        touchStartInfo = null;
    }
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
mobileKb.addEventListener("focus", () => {
    kbOpen = true;
    const btn = document.getElementById("btn-kb");
    if (btn) btn.classList.add("active-toggle");
});
mobileKb.addEventListener("blur", () => {
    kbOpen = false;
    const btn = document.getElementById("btn-kb");
    if (btn) btn.classList.remove("active-toggle");
});
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
