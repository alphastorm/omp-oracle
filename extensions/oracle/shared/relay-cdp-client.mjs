// Purpose: Minimal CDP client over the browser relay for reading out-of-process iframes.
// Responsibilities: Attach to a page target, arm auto-attach, hand out iframe child sessions,
// evaluate expressions inside them, and surface session events (downloads) to subscribers.
// Chrome's Target.setAutoAttach is not retroactive, so callers must arm it before the frame they
// want is created; the relay forwards the resulting child sessions with standard flat-session
// routing (verified on OMP 18.2.6).
// Invariants/Assumptions: One client per job; the page target is the job-owned pinned tab; the
// client never creates, closes, or selects tabs.

const CDP_COMMAND_TIMEOUT_MS = 10_000;

/** @typedef {{ sessionId: string; targetId: string; type: string; url: string }} RelayFrameSession */
/** @typedef {{ method: string; sessionId?: string; params: Record<string, any> }} RelayCdpEvent */

export class RelayCdpClient {
  /** @type {WebSocket | undefined} */
  #socket;
  #nextId = 1;
  /** @type {Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>} */
  #pending = new Map();
  /** @type {RelayFrameSession[]} */
  #frames = [];
  /** @type {Map<string, Set<(event: RelayCdpEvent) => void>>} */
  #listeners = new Map();

  /**
   * @param {string} endpoint relay HTTP origin, e.g. http://127.0.0.1:9224
   * @returns {Promise<RelayCdpClient>}
   */
  static async connect(endpoint) {
    const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Browser relay is unavailable for frame access.");
    const { webSocketDebuggerUrl } = await response.json();
    if (typeof webSocketDebuggerUrl !== "string") throw new Error("Browser relay did not report a CDP endpoint.");
    const client = new RelayCdpClient();
    await client.#open(webSocketDebuggerUrl);
    return client;
  }

  /** @param {string} url */
  #open(url) {
    const socket = new WebSocket(url);
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    socket.addEventListener("close", () => this.#rejectAll(new Error("Browser relay CDP connection closed.")));
    const { promise, resolve, reject } = Promise.withResolvers();
    socket.addEventListener("open", () => resolve(undefined), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not open the browser relay CDP connection.")), { once: true });
    return promise;
  }

  /** @param {string} raw */
  #onMessage(raw) {
    /** @type {{ id?: number; method?: string; params?: { sessionId?: string; targetInfo?: { targetId?: string; type?: string; url?: string } }; result?: unknown; error?: { message?: string } }} */
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.#pending.has(message.id)) {
      const entry = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (!entry) return;
      if (message.error) entry.reject(new Error(message.error.message || "CDP command failed"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Target.attachedToTarget" && message.params?.sessionId && message.params.targetInfo) {
      const info = message.params.targetInfo;
      this.#frames.push({ sessionId: message.params.sessionId, targetId: info.targetId || "", type: info.type || "", url: info.url || "" });
    }
    if (message.method && this.#listeners.has(message.method)) {
      const event = { method: message.method, sessionId: message.sessionId, params: message.params || {} };
      for (const listener of this.#listeners.get(message.method) || []) listener(event);
    }
  }

  /** @param {Error} error */
  #rejectAll(error) {
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs] per-command deadline; long in-page waits must raise it
   * @returns {Promise<unknown>}
   */
  send(method, params = {}, sessionId = undefined, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser relay CDP connection is not open."));
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    // A pending deadline must not outlive its command: it would hold the worker process open.
    const deadline = setTimeout(() => {
      if (!this.#pending.has(id)) return;
      this.#pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    deadline.unref?.();
    this.#pending.set(id, {
      resolve: (value) => { clearTimeout(deadline); resolve(value); },
      reject: (error) => { clearTimeout(deadline); reject(error); },
    });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return promise;
  }

  /**
   * Subscribe to a CDP event on any session this client owns. Returns the unsubscribe function.
   * @param {string} method
   * @param {(event: RelayCdpEvent) => void} listener
   * @returns {() => void}
   */
  on(method, listener) {
    const listeners = this.#listeners.get(method) || new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => { listeners.delete(listener); };
  }

  /**
   * Attach to a page target and arm child auto-attach so iframes created from now on surface as
   * sessions. Must run before the frame of interest exists.
   * @param {string} targetId
   * @returns {Promise<string>} the page session id
   */
  async armFrameCapture(targetId) {
    const attached = /** @type {{ sessionId?: string }} */ (await this.send("Target.attachToTarget", { targetId, flatten: true }));
    if (!attached?.sessionId) throw new Error("Browser relay did not return a page session.");
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, attached.sessionId);
    return attached.sessionId;
  }

  /** Iframe child sessions observed since arming, oldest first. */
  frameSessions() {
    return this.#frames.filter((frame) => frame.type === "iframe");
  }

  /**
   * Evaluate an expression in a session and return its value, or undefined on any failure.
   * @param {string} sessionId
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  async evaluate(sessionId, expression) {
    try {
      const result = /** @type {{ result?: { value?: unknown } }} */ (await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId));
      return result?.result?.value;
    } catch {
      return undefined;
    }
  }

  close() {
    this.#socket?.close();
    this.#socket = undefined;
    this.#rejectAll(new Error("Browser relay CDP client closed."));
  }
}
