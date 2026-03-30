require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
} = require("wrtc");
const SessionManager = require("./session-manager");

// --- Configuration ---

const PORT = process.env.PORT || 19000;
const CHAT_APP_WS_URL = process.env.CHAT_APP_WS_URL || "ws://localhost:4001/ws/calling";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const SERVICE_NAME = "whatsapp-calling-service";

const STUN_URL = process.env.STUN_URL || "stun:stun.relay.metered.ca:80";
const TURN_URL = process.env.TURN_URL || "";
const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";

function getIceServers() {
  const servers = [{ urls: STUN_URL }];
  if (TURN_URL) {
    servers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }
  return servers;
}

// --- State ---

const sessions = new SessionManager();
let chatAppWs = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// --- HTTP server (health check) ---

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      activeSessions: sessions.size,
      chatAppConnected: chatAppWs?.readyState === WebSocket.OPEN,
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WhatsApp Calling Service running");
});

// --- WebSocket connection to chat-app ---

function connectToChatApp() {
  const token = jwt.sign({ service: SERVICE_NAME }, JWT_SECRET, { expiresIn: "24h" });

  console.log(`[WS] Connecting to chat-app at ${CHAT_APP_WS_URL}...`);
  chatAppWs = new WebSocket(CHAT_APP_WS_URL, {
    headers: { authorization: `Bearer ${token}` },
  });

  chatAppWs.on("open", () => {
    console.log("[WS] Connected to chat-app");
    reconnectAttempts = 0;
  });

  chatAppWs.on("message", (raw) => {
    try {
      const message = JSON.parse(raw);
      handleChatAppMessage(message);
    } catch (err) {
      console.error("[WS] Failed to parse message:", err.message);
    }
  });

  chatAppWs.on("close", () => {
    console.log("[WS] Disconnected from chat-app");
    scheduleReconnect();
  });

  chatAppWs.on("error", (err) => {
    console.error("[WS] Connection error:", err.message);
  });
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
  setTimeout(connectToChatApp, delay);
}

function sendToChatApp(event, payload) {
  if (!chatAppWs || chatAppWs.readyState !== WebSocket.OPEN) {
    console.warn("[WS] Cannot send — not connected to chat-app");
    return false;
  }
  chatAppWs.send(JSON.stringify({ event, ...payload }));
  return true;
}

// --- Handle commands from chat-app ---

function handleChatAppMessage(message) {
  const { event, callId } = message;

  switch (event) {
    case "start_call":
      handleStartCall(message);
      break;
    case "whatsapp_offer":
      handleWhatsappOffer(message);
      break;
    case "browser_offer":
      handleBrowserOffer(message);
      break;
    case "browser_candidate":
      handleBrowserCandidate(message);
      break;
    case "accept_call":
      handleAcceptCall(message);
      break;
    case "end_call":
      handleEndCall(callId);
      break;
    default:
      console.warn(`[WS] Unknown event: ${event}`);
  }
}

// --- Call handlers ---

function handleStartCall({ callId, callType, userId, callerName, callerNumber }) {
  const session = sessions.create(callId, {
    callType: callType || "audio",
    userId,
    callerName,
    callerNumber,
  });
  console.log(`[Call] Session started: ${callId} (${session.callType})`);
}

function handleWhatsappOffer({ callId, sdp }) {
  const session = sessions.get(callId);
  if (!session) {
    console.warn(`[Call] No session for WhatsApp offer: ${callId}`);
    return;
  }

  session.whatsappOfferSdp = sdp;
  console.log(`[Call] WhatsApp SDP offer received for: ${callId}`);
  tryInitiateBridge(callId);
}

function handleBrowserOffer({ callId, sdp }) {
  const session = sessions.get(callId);
  if (!session) {
    console.warn(`[Call] No session for browser offer: ${callId}`);
    return;
  }

  session.browserOfferSdp = sdp;
  console.log(`[Call] Browser SDP offer received for: ${callId}`);
  tryInitiateBridge(callId);
}

function handleBrowserCandidate({ callId, candidate }) {
  const session = sessions.get(callId);
  if (!session?.browserPc) {
    console.warn(`[Call] Cannot add ICE candidate — no browser PC for: ${callId}`);
    return;
  }

  try {
    session.browserPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error(`[Call] Failed to add ICE candidate for ${callId}:`, err.message);
  }
}

function handleAcceptCall({ callId }) {
  const session = sessions.get(callId);
  if (!session) return;

  sessions.update(callId, { status: "accepted" });
  console.log(`[Call] Call accepted: ${callId}`);
}

function handleEndCall(callId) {
  const session = sessions.get(callId);
  if (!session) return;

  console.log(`[Call] Ending call: ${callId}`);
  sendToChatApp("call_ended", { callId, duration: getDuration(session) });
  sessions.cleanup(callId);
}

function getDuration(session) {
  if (!session.answeredAt) return 0;
  return Math.floor((Date.now() - session.answeredAt) / 1000);
}

// --- WebRTC Bridge ---

async function tryInitiateBridge(callId) {
  const session = sessions.get(callId);
  if (!session || !session.browserOfferSdp || !session.whatsappOfferSdp) return;

  try {
    await initiateBridge(session);
  } catch (err) {
    console.error(`[Bridge] Failed for ${callId}:`, err.message);
    sendToChatApp("call_error", { callId, error: err.message });
    sessions.cleanup(callId);
  }
}

async function initiateBridge(session) {
  const { callId, callType } = session;
  const iceServers = getIceServers();
  const includeVideo = callType === "video";

  // --- Browser peer connection ---
  session.browserPc = new RTCPeerConnection({ iceServers });
  session.browserStream = new MediaStream();

  session.browserPc.ontrack = (event) => {
    const kind = event.track.kind;
    console.log(`[Bridge] ${kind} track received from browser for: ${callId}`);
    event.streams[0].getTracks().forEach((track) => session.browserStream.addTrack(track));
  };

  session.browserPc.onicecandidate = (event) => {
    if (event.candidate) {
      sendToChatApp("browser_candidate", { callId, candidate: event.candidate });
    }
  };

  await session.browserPc.setRemoteDescription(
    new RTCSessionDescription({ type: "offer", sdp: session.browserOfferSdp })
  );
  console.log(`[Bridge] Browser offer set for: ${callId}`);

  // --- WhatsApp peer connection ---
  session.whatsappPc = new RTCPeerConnection({ iceServers });

  const waTrackPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WhatsApp track")), 15000);
    let tracksReceived = 0;
    const expectedTracks = includeVideo ? 2 : 1;

    session.whatsappPc.ontrack = (event) => {
      const kind = event.track.kind;
      console.log(`[Bridge] ${kind} track received from WhatsApp for: ${callId}`);

      if (!session.whatsappStream) {
        session.whatsappStream = event.streams[0];
      } else {
        event.streams[0].getTracks().forEach((track) => session.whatsappStream.addTrack(track));
      }

      tracksReceived++;
      if (tracksReceived >= expectedTracks) {
        clearTimeout(timeout);
        resolve();
      }
    };
  });

  await session.whatsappPc.setRemoteDescription(
    new RTCSessionDescription({ type: "offer", sdp: session.whatsappOfferSdp })
  );
  console.log(`[Bridge] WhatsApp offer set for: ${callId}`);

  // Forward browser audio to WhatsApp
  session.browserStream.getAudioTracks().forEach((track) => {
    session.whatsappPc.addTrack(track, session.browserStream);
  });

  // Forward browser video to WhatsApp (if video call)
  if (includeVideo) {
    session.browserStream.getVideoTracks().forEach((track) => {
      session.whatsappPc.addTrack(track, session.browserStream);
    });
  }

  console.log(`[Bridge] Forwarded browser tracks to WhatsApp for: ${callId}`);

  // Wait for WhatsApp tracks
  await waTrackPromise;

  // Forward WhatsApp audio to browser
  session.whatsappStream.getAudioTracks().forEach((track) => {
    session.browserPc.addTrack(track, session.whatsappStream);
  });

  // Forward WhatsApp video to browser (if video call)
  if (includeVideo) {
    session.whatsappStream.getVideoTracks().forEach((track) => {
      session.browserPc.addTrack(track, session.whatsappStream);
    });
  }

  // --- Create SDP answers ---
  const browserAnswer = await session.browserPc.createAnswer();
  await session.browserPc.setLocalDescription(browserAnswer);
  sendToChatApp("browser_answer", { callId, sdp: browserAnswer.sdp });
  console.log(`[Bridge] Browser answer sent for: ${callId}`);

  const waAnswer = await session.whatsappPc.createAnswer();
  await session.whatsappPc.setLocalDescription(waAnswer);
  const finalWaSdp = waAnswer.sdp.replace("a=setup:actpass", "a=setup:active");

  sendToChatApp("whatsapp_answer", { callId, sdp: finalWaSdp });
  console.log(`[Bridge] WhatsApp answer sent for: ${callId}`);

  sessions.update(callId, {
    status: "connected",
    answeredAt: Date.now(),
    browserOfferSdp: null,
    whatsappOfferSdp: null,
  });

  sendToChatApp("call_connected", { callId });
}

// --- Start ---

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] Running at http://0.0.0.0:${PORT}`);
  connectToChatApp();
});
