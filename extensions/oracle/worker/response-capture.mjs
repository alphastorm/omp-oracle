// Browser-side capture deliberately has no closure dependencies: the worker evaluates this
// same function in the owned page or bound report frame; synthetic proofs use it unchanged.
import { createHash } from "node:crypto";

export function captureScopedResponse({ responseIndex = 0, messageId, report = false } = {}) {
  const doc = document;
  const nodes = [...doc.querySelectorAll('[data-message-author-role="assistant"], [data-testid="assistant-message"]')]
    .filter((node) => !node.parentElement?.closest('[data-message-author-role="assistant"], [data-testid="assistant-message"]'));
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter((node) => node.textContent?.trim() === "ChatGPT said:");
  const headingRoots = headings.map((heading) => heading.nextElementSibling);
  const responseRoots = headingRoots.some((node) => (node?.textContent || '').trim()) ? headingRoots : nodes;
  const rootIds = (node) => new Set([node.getAttribute("data-message-id"), node.closest("[data-message-id]")?.getAttribute("data-message-id"),
    ...[...node.querySelectorAll("[data-message-id]")].map((child) => child.getAttribute("data-message-id"))].filter(Boolean));
  const rootId = (node) => {
    if (!node) return undefined;
    const ids = rootIds(node);
    return ids.size === 1 ? [...ids][0] : undefined;
  };
  const matches = messageId && !report ? responseRoots.filter((node) => rootId(node) === messageId) : [];
  if (messageId && !report && matches.length !== 1) throw new Error("Bound response message ID is absent or ambiguous.");
  const root = report ? doc.querySelector('[data-report-id], [data-testid="research-report"], main, article') || doc.body
    : messageId ? matches[0] : responseRoots[responseIndex];
  if (!root) throw new Error("Bound response root is absent; whole-conversation capture is forbidden.");
  // A positional root that spans several message identities is not one turn: refuse it rather
  // than bind a content hash to an unknown mixture. A root with no identity at all (UI drift)
  // still binds positionally by content hash, which recollection then refuses unless it matches.
  if (!report && rootIds(root).size > 1) throw new Error("Bound response root spans several message IDs; refusing an ambiguous turn.");
  const actualId = rootId(root);
  if (messageId && actualId !== messageId) throw new Error("Bound response message ID does not match.");
  const safeUrl = (value) => {
    try {
      const url = new URL(value, doc.baseURI);
      if (!/^https?:$/.test(url.protocol)) return undefined;
      if ([...url.searchParams.keys()].some((key) => /^(?:x-amz-.+|x-goog-.+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)$/i.test(key))) return undefined;
      return url.href;
    } catch { return undefined; }
  };
  const sources = [...root.querySelectorAll('a[href]')].map((node, index) => {
    const url = safeUrl(node.getAttribute('href'));
    const artifact = node.hasAttribute('download') || /sandbox:|\/files\/|estuary\/content|blob:/.test(node.getAttribute('href') || '');
    return { id: `source-${index + 1}`, kind: artifact ? 'artifact' : 'citation', label: node.textContent || node.getAttribute('aria-label') || '', ...(url ? { url } : { unresolved: true }) };
  });
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,form,input,textarea').forEach((node) => node.remove());
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'href') {
        const url = safeUrl(attribute.value);
        if (url) node.setAttribute('href', url); else node.removeAttribute('href');
      } else if (!['class','role','aria-label','colspan','rowspan','data-message-id','data-message-author-role','data-report-id'].includes(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  const codeBlocks = [...root.querySelectorAll('pre')].filter((pre) => !pre.querySelector('pre')).map((pre, index) => {
    const code = pre.querySelector('code') || pre;
    return { index, language: (code.className || '').match(/language-([\w-]+)/)?.[1] || '', text: code.textContent || '' };
  });
  const sourceUrls = new Set(sources.flatMap((source) => source.url ? [source.url] : []));
  const addLiteralSources = (text) => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
      const url = safeUrl(match[0]);
      if (!url || sourceUrls.has(url)) continue;
      sourceUrls.add(url);
      sources.push({ id: `source-${sources.length + 1}`, kind: 'citation', label: match[0], url });
    }
  };
  for (const block of codeBlocks) addLiteralSources(block.text);
  addLiteralSources(root.innerText || root.textContent || '');
  const render = (node) => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','button','svg','iframe','form'].includes(tag)) return '';
    if (tag === 'pre') {
      const code = node.querySelector('code') || node;
      const text = code.textContent || '';
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `\n\n${fence}${(code.className || '').match(/language-([\w-]+)/)?.[1] || ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    const body = [...node.childNodes].map(render).join('');
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === 'a') { const url = safeUrl(node.getAttribute('href')); return url ? `[${body}](${url})` : body; }
    if (tag === 'strong' || tag === 'b') return `**${body}**`;
    if (tag === 'em' || tag === 'i') return `*${body}*`;
    if (tag === 'code') return '`' + body + '`';
    if (tag === 'br') return '\n';
    if (tag === 'li') return `\n${node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}.` : '-'} ${body.trim()}`;
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => render(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
      if (!rows.length) return '';
      return '\n\n' + rows.map((row, index) => '| ' + row.join(' | ') + ' |' + (index === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n\n';
    }
    if (tag === 'blockquote') return '\n\n' + body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
    return ['p','div','section','article','ul','ol'].includes(tag) ? `\n\n${body}\n\n` : body;
  };
  const controls = [...root.querySelectorAll('a,button,[role="button"],[role="menuitem"]')];
  const candidateFileName = (node) => {
    const context = node.closest('[role="group"],li,p,figure,[data-testid*="file"]')?.textContent || '';
    return node.getAttribute('download') || context.match(/[A-Za-z0-9._-]+\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)\b/i)?.[0] || undefined;
  };
  const candidateStableLabel = (node) => candidateFileName(node) || (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim() || 'Download';
  const candidates = controls.flatMap((node, index) => {
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim();
    const href = node.getAttribute('href') || '';
    const namedFile = node.tagName === 'A' && /\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)(?:$|[?#])/i.test(href)
      && /\.(?:md|txt|csv|tsv|json|pdf|docx|xlsx|pptx|zip|png|jpe?g)\b/i.test(label);
    const structural = node.hasAttribute('download') || /(?:download|export)/i.test(label) || /sandbox:|\/files\/|estuary\/content|blob:/.test(href)
      || namedFile
      || (report && /^(?:Markdown|Word|PDF)(?:\s*\(.*\))?$/i.test(label));
    if (!structural) return [];
    const fileName = candidateFileName(node);
    const stableLabel = candidateStableLabel(node);
    const occurrence = controls.slice(0, index).filter((prior) => candidateStableLabel(prior) === stableLabel).length;
    let hash = 2166136261;
    for (const char of `${stableLabel}|${occurrence}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const marker = `oracle-capture-${responseIndex}-${index}`;
    node.setAttribute('data-oracle-capture', marker);
    return [{ candidateId: `candidate-${hash.toString(16)}`, label: stableLabel, selector: `[data-oracle-capture="${marker}"]`, fileName, nativeMarkdown: report && /markdown|\.md\b/i.test(label) }];
  });
  const frames = [...root.querySelectorAll('iframe')].map((node, index) => {
    const marker = `oracle-frame-${responseIndex}-${index}`;
    node.setAttribute('data-oracle-capture', marker);
    return { selector: `[data-oracle-capture="${marker}"]`, src: node.src };
  });
  return { messageId: actualId, title: root.querySelector('h1,h2')?.textContent?.trim(), rawText: root.innerText || root.textContent || '', rawHtml: clone.outerHTML,
    markdown: render(clone).trim(), codeBlocks, sources, candidates, frames };
}

export function captureExpression(options = {}, frameDocument = false) {
  return frameDocument
    ? `(() => { const document = frames[0]?.document || globalThis.document; return (${captureScopedResponse.toString()})(${JSON.stringify(options)}); })()`
    : `(${captureScopedResponse.toString()})(${JSON.stringify(options)})`;
}

// Listen before activation. Read only bytes exposed by the UI's actual download, never
// synthesize private API requests. Hooks are restored even when an export fails.
export async function captureDownload(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Bound download control disappeared.');
  const nativeFetch = window.fetch;
  const originalFetch = nativeFetch.bind(window);
  const originalOpen = window.open;
  const originalClick = HTMLAnchorElement.prototype.click;
  let captured;
  let failure;
  const pending = [];
  const followed = new Set();
  const capture = async (response, fileName = '') => {
    if (!response.ok) throw new Error('Download request did not succeed.');
    const contentType = response.headers.get('content-type') || '';
    if (/json|html/i.test(contentType)) return;
    const length = response.headers.get('content-length');
    if (length && Number(length) > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
    const buffer = await response.clone().arrayBuffer();
    if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    captured = { bytesBase64: btoa(binary), contentType, fileName, ...(length && !response.headers.get('content-encoding') ? { expectedSize: Number(length) } : {}) };
  };
  const follow = (url, fileName) => {
    if (!url || followed.has(url)) return;
    followed.add(url);
    pending.push(originalFetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => capture(response, fileName)).catch(() => { failure = 'Download bytes could not be read.'; }));
  };
  const listener = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (anchor && (anchor.hasAttribute('download') || /^(?:blob:|data:)/.test(anchor.href))) follow(anchor.href, anchor.download);
  };
  try {
    document.addEventListener('click', listener, true);
    HTMLAnchorElement.prototype.click = function () { follow(this.href, this.download); return originalClick.call(this); };
    window.open = (url) => { follow(url, ''); return null; };
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (/attachment/i.test(response.headers.get('content-disposition') || '') || /(?:markdown|octet-stream|application\/pdf)/i.test(response.headers.get('content-type') || '')) {
        pending.push(capture(response).catch(() => { failure = 'Download bytes could not be read.'; }));
      }
      return response;
    };
    if (element.tagName === 'A') follow(element.href, element.download);
    element.click();
    for (let poll = 0; poll < 30 && !captured; poll += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (!captured) throw new Error(failure || 'Native control did not expose downloadable bytes.');
    return captured;
  } finally {
    document.removeEventListener('click', listener, true);
    window.fetch = nativeFetch;
    window.open = originalOpen;
    HTMLAnchorElement.prototype.click = originalClick;
  }
}

// A report's Export control opens an asynchronous menu; the actual option is "Export to Markdown".
// Activation only: the bytes are observed by the pre-armed native download collector, because the
// sandboxed report frame delegates the download to a realm this document cannot see.
export async function activateDownloadControl(selector, report = false) {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Bound download control disappeared.');
  element.click();
  if (!report) return { activated: true };
  for (let poll = 0; poll < 50; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const options = [...document.querySelectorAll('[role=menuitem],button,a')].filter((node) => node.getClientRects().length && /^(?:Export to )?Markdown(?:\s*\(.*\))?$/i.test((node.textContent || '').trim()));
    if (options.length === 1 && options[0] !== element) {
      options[0].click();
      return { activated: true, menuOption: (options[0].textContent || '').trim() };
    }
  }
  throw new Error('The report export menu did not offer a Markdown option.');
}

// Chrome reports a download's object URL but, through the extension relay, never its saved path.
// Remember every Blob the UI turns into an object URL while armed, so the exact bytes Chrome saved
// stay readable after the app revokes the URL. Covers this window and its same-origin child.
export function armDownloadRegistry() {
  const targets = [window];
  try { if (frames[0]?.document) targets.push(frames[0]); } catch { /* cross-origin child: its own session arms it */ }
  const map = window.__oracleDownloadRegistry?.map || new Map();
  // The top realm remembers every realm it armed; frame order at disarm time is irrelevant.
  const armedRealms = window.__oracleDownloadRegistry?.armed || [];
  for (const target of targets) {
    if (target.__oracleDownloadRegistry) continue;
    const original = target.URL.createObjectURL;
    target.URL.createObjectURL = function (object) {
      const url = original.call(target.URL, object);
      if (object && typeof object.arrayBuffer === 'function') map.set(url, object);
      return url;
    };
    target.__oracleDownloadRegistry = { map, armed: armedRealms, restore: () => { target.URL.createObjectURL = original; delete target.__oracleDownloadRegistry; } };
    armedRealms.push(target);
  }
  return armedRealms.length;
}

export function disarmDownloadRegistry() {
  const armedRealms = window.__oracleDownloadRegistry?.armed || [];
  let restored = 0;
  for (const target of [...armedRealms]) {
    try { target.__oracleDownloadRegistry?.restore(); restored += 1; } catch { /* realm already gone */ }
  }
  armedRealms.length = 0;
  return restored;
}

export async function readRegisteredDownload(url) {
  const blob = window.__oracleDownloadRegistry?.map.get(url);
  if (!blob) throw new Error('The downloaded object URL was not created while the registry was armed.');
  if (blob.size > 25 * 1024 * 1024) throw new Error('Download exceeds capture limit.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const CAPTURE_LIMIT_BYTES = 25 * 1024 * 1024;

export function decodeDataUrl(url) {
  const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) throw new Error('Malformed data URL download.');
  // Base64 inflates by 4/3 and percent-encoding by up to 3x; bound the encoded length before decoding.
  if (match[3].length > CAPTURE_LIMIT_BYTES * 3) throw new Error('Download exceeds capture limit.');
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  if (bytes.length > CAPTURE_LIMIT_BYTES) throw new Error('Download exceeds capture limit.');
  return bytes;
}

function frameTreeIds(node) {
  return [node.frame.id, ...(node.childFrames || []).flatMap(frameTreeIds)];
}

async function evaluateOrThrow(cdp, sessionId, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text || 'Evaluation failed.');
  return result.result?.value;
}

// Pre-armed native download collection over CDP. Page.downloadWillBegin/downloadProgress fire on
// the session that owns the originating frame with no download-behavior change, so the user's
// download destination is never touched. Accepted origins are exact: the tab's main frame (the
// host performs sandboxed exports) or the bound report frame tree. Bytes come only from the UI's
// own blob or data URL; a transport URL is reported as a precise gap instead of being refetched.
export async function collectNativeDownload({ cdp, pageSessionId, frameSessionId, activate, timeoutMs = 30_000, onWait }) {
  const sessions = frameSessionId ? [pageSessionId, frameSessionId] : [pageSessionId];
  const events = [];
  const unsubscribe = [cdp.on('Page.downloadWillBegin', (event) => events.push(event)), cdp.on('Page.downloadProgress', (event) => events.push(event))];
  const armedRealms = [];
  try {
    const accepted = new Set();
    for (const sessionId of sessions) {
      await cdp.send('Page.enable', {}, sessionId);
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
      for (const id of sessionId === pageSessionId && frameSessionId ? [frameTree.frame.id] : frameTreeIds(frameTree)) accepted.add(id);
      await evaluateOrThrow(cdp, sessionId, `(${armDownloadRegistry.toString()})()`);
      armedRealms.push(sessionId);
    }
    // Only downloads that begin at or after activation are candidates; anything observed while
    // arming (Page.enable, frame discovery, registry hooks) is not caused by the export control.
    const activationBoundary = events.length;
    const activation = await activate();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + timeoutMs;
    let begin;
    while (!begin && Date.now() < deadline) {
      begin = events.slice(activationBoundary).find((event) => event.method === 'Page.downloadWillBegin' && sessions.includes(event.sessionId || '') && accepted.has(event.params.frameId));
      if (!begin) { await sleep(100); onWait?.(); }
    }
    if (!begin) {
      const foreign = events.slice(activationBoundary).find((event) => event.method === 'Page.downloadWillBegin');
      throw new Error(foreign ? 'A download started outside the bound frame tree; refusing to collect it.' : 'The native export did not start a browser download.');
    }
    let final;
    while (!final && Date.now() < deadline) {
      final = events.find((event) => event.method === 'Page.downloadProgress' && event.params.guid === begin.params.guid && event.params.state !== 'inProgress');
      if (!final) { await sleep(100); onWait?.(); }
    }
    if (!final) throw new Error('The browser download did not finish before the collection deadline.');
    if (final.params.state !== 'completed') throw new Error('The browser download was canceled or interrupted.');
    const url = String(begin.params.url || '');
    let bytes;
    let source;
    if (url.startsWith('data:')) { bytes = decodeDataUrl(url); source = 'data'; }
    else if (url.startsWith('blob:')) {
      bytes = Buffer.from(String(await evaluateOrThrow(cdp, begin.sessionId, `(${readRegisteredDownload.toString()})(${JSON.stringify(url)})`, timeoutMs)), 'base64');
      source = 'blob';
    } else throw new Error('The browser download came from a transport URL the capture hooks do not read; the relay reports no saved path.');
    const totalBytes = Number(final.params.totalBytes) || 0;
    return {
      bytesBase64: bytes.toString('base64'), fileName: String(begin.params.suggestedFilename || ''), contentType: '',
      ...(totalBytes > 0 ? { expectedSize: totalBytes } : {}),
      native: { guid: begin.params.guid, frameId: begin.params.frameId, source, totalBytes, activation },
    };
  } finally {
    for (const listener of unsubscribe) listener();
    for (const sessionId of armedRealms) await cdp.evaluate(sessionId, `(${disarmDownloadRegistry.toString()})()`);
  }
}

// Identity for a turn that carries no data-message-id. ChatGPT re-renders the same turn with
// different class attributes, so a hash of the sanitized HTML changes between visits and an
// index-only binding could never be recollected; the turn's normalized text does not change.
export function turnContentSha256(rawText) {
  return createHash('sha256').update(String(rawText || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

export function redactTransportSecrets(text) {
  return String(text).replace(/https?:\/\/[^\s<>"')]+/g, (value) => {
    if (/(?:[?&]|&amp;)(?:x-amz-[^=&#]+|x-goog-[^=&#]+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)=/i.test(value)) return '[transport-url-redacted]';
    try {
      const url = new URL(value);
      return [...url.searchParams.keys()].some((key) => /^(?:x-amz-.+|x-goog-.+|sig|signature|token|access_token|auth|key-pair-id|policy|expires|se|sp|sv)$/i.test(key)) ? '[transport-url-redacted]' : value;
    } catch { return value; }
  });
}

export function validateArtifactBytes(bytes, { fileName = '', contentType = '', expectedSize } = {}) {
  if (!bytes.length) throw new Error('Download is empty.');
  if (expectedSize !== undefined && bytes.length !== expectedSize) throw new Error('Download size does not match the declared size.');
  const text = bytes.subarray(0, 8192).toString('utf8').trimStart();
  if (/^(?:<!doctype\s+html|<html|<head|<body)/i.test(text) || /text\/html/i.test(contentType)) throw new Error('Download is HTML, not a document.');
  const ext = fileName.toLowerCase().split('.').at(-1);
  if (/^[\[{]/.test(text) || /application\/json/i.test(contentType)) {
    try {
      const payload = JSON.parse(bytes.toString('utf8'));
      if (ext !== 'json' || (!Array.isArray(payload) && payload && ['download_url','downloadUrl','error','redirect'].some((key) => key in payload))) throw new Error('Download is JSON metadata, not a document.');
    }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  let detectedType = 'text/plain';
  if (bytes.subarray(0, 5).toString() === '%PDF-') {
    if (!bytes.subarray(-2048).toString().includes('%%EOF')) throw new Error('PDF download is incomplete.');
    detectedType = 'application/pdf';
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const eocd = bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
    if (eocd < Math.max(0, bytes.length - 65557) || eocd + 22 > bytes.length || bytes.readUInt16LE(eocd + 20) !== bytes.length - eocd - 22) throw new Error('ZIP document is incomplete.');
    const requiredMember = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[ext];
    if (requiredMember && (!bytes.includes(Buffer.from(requiredMember)) || !bytes.includes(Buffer.from('[Content_Types].xml')))) throw new Error('ZIP does not contain the expected Office document.');
    detectedType = 'application/zip';
  } else if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (!bytes.subarray(-12).includes(Buffer.from('IEND'))) throw new Error('PNG download is incomplete.');
    detectedType = 'image/png';
  } else {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Unrecognized binary document; validation is unconfirmed.'); }
    if (bytes.includes(0)) throw new Error('Unrecognized binary document; validation is unconfirmed.');
  }
  if ((ext === 'pdf' && detectedType !== 'application/pdf') || (['docx','xlsx','pptx','zip'].includes(ext) && detectedType !== 'application/zip')
    || (ext === 'png' && detectedType !== 'image/png') || (['md','txt','csv'].includes(ext) && detectedType !== 'text/plain')) throw new Error('Downloaded bytes do not match the expected format.');
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), detectedType };
}

export function collectionOutcome({ hasResponse, fidelity, inspection, artifacts = [], requiredMissing = [], optionalMissing = [] }) {
  const required = [...requiredMissing];
  const optional = [...optionalMissing];
  if (!hasResponse) required.push('response');
  if (fidelity === 'text_only') required.push('rich_response_fidelity');
  if (inspection !== 'inspected') optional.push(`artifact_inspection:${inspection}`);
  for (const item of artifacts) {
    if (item.state === undefined && !item.candidateId) continue; // legacy manifest: absence is unknown, not a newly failed inspection
    if (item.state !== 'validated') (item.required ? required : optional).push(`artifact:${item.candidateId || item.displayName || 'unknown'}`);
  }
  return { collectionStatus: !hasResponse ? 'failed' : required.length || optional.length ? 'partial' : 'complete',
    collectionRequiredMissing: [...new Set(required)], collectionOptionalMissing: [...new Set(optional)] };
}
