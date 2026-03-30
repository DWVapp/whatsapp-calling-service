/**
 * Manages multiple concurrent call sessions.
 * Each session is identified by a callId and holds its own
 * WebRTC peer connections, streams, and metadata.
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  create(callId, data = {}) {
    if (this.sessions.has(callId)) {
      return this.sessions.get(callId);
    }

    const session = {
      callId,
      browserPc: null,
      browserStream: null,
      whatsappPc: null,
      whatsappStream: null,
      browserOfferSdp: null,
      whatsappOfferSdp: null,
      browserSocket: null,
      callType: "audio",
      status: "ringing",
      callerName: null,
      callerNumber: null,
      userId: null,
      createdAt: Date.now(),
      ...data,
    };

    this.sessions.set(callId, session);
    console.log(`[SessionManager] Session created: ${callId}`);
    return session;
  }

  get(callId) {
    return this.sessions.get(callId) || null;
  }

  update(callId, data) {
    const session = this.sessions.get(callId);
    if (!session) return null;

    Object.assign(session, data);
    return session;
  }

  getByUserId(userId) {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.status !== "ended") {
        return session;
      }
    }
    return null;
  }

  cleanup(callId) {
    const session = this.sessions.get(callId);
    if (!session) return;

    try {
      if (session.browserPc) session.browserPc.close();
      if (session.whatsappPc) session.whatsappPc.close();
    } catch (err) {
      console.error(`[SessionManager] Cleanup error ${callId}:`, err.message);
    }

    this.sessions.delete(callId);
    console.log(`[SessionManager] Cleaned up: ${callId}. Active: ${this.sessions.size}`);
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = SessionManager;
