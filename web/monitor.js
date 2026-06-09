import { MeshViewer } from './viewer.js';

const canvas = document.getElementById('view');
const statusEl = document.getElementById('status');
const messageTreeEl = document.getElementById('messageTree');
const refreshMonitorButton = document.getElementById('refreshMonitor');
const clearMonitorButton = document.getElementById('clearMonitor');
const rotateModeButton = document.getElementById('rotateMode');
const panModeButton = document.getElementById('panMode');
const resetViewButton = document.getElementById('resetView');

const viewer = new MeshViewer(canvas);
let monitorInfo = null;
let selectedMessageId = null;
let selectedLatest = true;
let messageListVersion = -1;

function findJsonHeaderEnd(bytes) {
  const newline = bytes.indexOf(10);
  if (newline < 0) {
    throw new Error('monitor snapshot is missing JSON header terminator');
  }
  return { headerEnd: newline + 1, textEnd: newline };
}

function typedPayloadView(Type, bytes, binaryStart, section) {
  if (!section) {
    throw new Error('monitor snapshot is missing a required section');
  }
  const offset = Number(section.offset);
  const count = Number(section.count);
  const components = Number(section.components);
  if (!Number.isFinite(offset) || !Number.isFinite(count) || !Number.isFinite(components)) {
    throw new Error('monitor section has invalid offset/count/components');
  }
  const items = count * components;
  const byteStart = binaryStart + offset;
  const byteEnd = byteStart + items * Type.BYTES_PER_ELEMENT;
  if (byteStart < binaryStart || byteEnd > bytes.byteLength) {
    throw new Error('monitor section points outside the binary payload');
  }

  const absolute = bytes.byteOffset + byteStart;
  if (absolute % Type.BYTES_PER_ELEMENT === 0) {
    return new Type(bytes.buffer, absolute, items);
  }
  return new Type(bytes.slice(byteStart, byteEnd).buffer);
}

function quadTriangles(quads) {
  const triangles = new Uint32Array((quads.length / 4) * 6);
  for (let q = 0, t = 0; q < quads.length; q += 4, t += 6) {
    const a = quads[q];
    const b = quads[q + 1];
    const c = quads[q + 2];
    const d = quads[q + 3];
    triangles[t] = a;
    triangles[t + 1] = b;
    triangles[t + 2] = c;
    triangles[t + 3] = a;
    triangles[t + 4] = c;
    triangles[t + 5] = d;
  }
  return triangles;
}

function quadEdges(quads) {
  const edges = [];
  const seen = new Set();
  function add(a, b) {
    if (a === b) {
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(lo, hi);
    }
  }
  for (let q = 0; q < quads.length; q += 4) {
    add(quads[q], quads[q + 1]);
    add(quads[q + 1], quads[q + 2]);
    add(quads[q + 2], quads[q + 3]);
    add(quads[q + 3], quads[q]);
  }
  return new Uint32Array(edges);
}

function vectorSegments(vectors, scale) {
  const segments = new Float32Array((vectors.length / 6) * 6);
  for (let i = 0; i < vectors.length; i += 6) {
    const x = vectors[i];
    const y = vectors[i + 1];
    const z = vectors[i + 2];
    segments[i] = x;
    segments[i + 1] = y;
    segments[i + 2] = z;
    segments[i + 3] = x + vectors[i + 3] * scale;
    segments[i + 4] = y + vectors[i + 4] * scale;
    segments[i + 5] = z + vectors[i + 5] * scale;
  }
  return segments;
}

function bindMonitorSnapshot(buffer, label = 'monitor socket') {
  const bytes = new Uint8Array(buffer);
  const jsonEnd = findJsonHeaderEnd(bytes);
  const headerText = new TextDecoder().decode(bytes.subarray(0, jsonEnd.textEnd));
  const header = JSON.parse(headerText);
  if (header.sviz_protocol !== 1) {
    throw new Error('unsupported monitor protocol');
  }
  if (header.endianness && header.endianness !== 'little') {
    throw new Error('only little-endian monitor payloads are supported');
  }

  const points = typedPayloadView(Float32Array, bytes, jsonEnd.headerEnd, header.points);
  const quads = typedPayloadView(Uint32Array, bytes, jsonEnd.headerEnd, header.quads);
  const vectors = header.vectors
    ? typedPayloadView(Float32Array, bytes, jsonEnd.headerEnd, header.vectors)
    : null;
  const vectorScale = Number(header.vector_scale || 1);
  viewer.bindRenderMesh({
    vertices: points,
    triangles: quadTriangles(quads),
    edges: quadEdges(quads),
    vectors: vectors ? vectorSegments(vectors, vectorScale) : null
  });

  const quadCount = Math.floor(quads.length / 4);
  const vectorCount = vectors ? Math.floor(vectors.length / 6) : 0;
  statusEl.textContent = `${points.length / 3} points, ${quadCount} quads, ${vectorCount} vectors from ${label}`;
}

async function loadSnapshot(id = null) {
  try {
    const params = new URLSearchParams({ ts: String(Date.now()) });
    if (id !== null) {
      params.set('id', String(id));
    }
    const response = await fetch('/monitor.bin?' + params.toString());
    if (response.status === 204) {
      const info = await fetchMonitorInfo();
      statusEl.textContent =
        `No monitor data received. Send snapshots to ${info.ingest_host}:${info.ingest_port}.`;
      return;
    }
    if (!response.ok) {
      throw new Error(`monitor fetch failed with HTTP ${response.status}`);
    }
    bindMonitorSnapshot(await response.arrayBuffer(), id === null ? 'latest' : `snapshot ${id}`);
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  }
}

async function refreshMonitor() {
  selectedLatest = true;
  selectedMessageId = null;
  await loadSnapshot();
  await refreshMessageList();
}

async function clearMonitor() {
  clearMonitorButton.disabled = true;
  try {
    const response = await fetch('/monitor-clear', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`monitor clear failed with HTTP ${response.status}`);
    }
    selectedLatest = true;
    selectedMessageId = null;
    messageListVersion = -1;
    viewer.clear();
    renderMessageTree([]);
    statusEl.textContent = 'Monitor messages cleared';
    await refreshMessageList();
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  } finally {
    clearMonitorButton.disabled = false;
  }
}

async function fetchMonitorInfo() {
  if (monitorInfo) {
    return monitorInfo;
  }
  const response = await fetch('/monitor-info.json?ts=' + Date.now());
  if (!response.ok) {
    throw new Error(`monitor info fetch failed with HTTP ${response.status}`);
  }
  monitorInfo = await response.json();
  return monitorInfo;
}

function groupMessages(messages) {
  const groups = new Map();
  for (const message of messages) {
    const name = message.name || 'monitor';
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(message);
  }
  for (const snapshots of groups.values()) {
    snapshots.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function renderMessageTree(messages) {
  messageTreeEl.textContent = '';
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No retained messages';
    messageTreeEl.appendChild(empty);
    return;
  }

  for (const [name, snapshots] of groupMessages(messages)) {
    const details = document.createElement('details');
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent = `${name} (${snapshots.length})`;
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'message-list';
    for (const snapshot of snapshots) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'message-item';
      if (Number(snapshot.id) === selectedMessageId) {
        item.classList.add('active');
      }
      const vectorText = Number(snapshot.vectors) > 0 ? `, ${snapshot.vectors} vectors` : '';
      item.textContent = `t${snapshot.sequence}: ${snapshot.quads} quads${vectorText}`;
      item.addEventListener('click', () => {
        selectedLatest = false;
        selectedMessageId = Number(snapshot.id);
        renderMessageTree(messages);
        loadSnapshot(selectedMessageId);
      });
      list.appendChild(item);
    }
    details.appendChild(list);
    messageTreeEl.appendChild(details);
  }
}

async function refreshMessageList() {
  try {
    const response = await fetch('/monitor-list.json?ts=' + Date.now());
    if (!response.ok) {
      throw new Error(`monitor list fetch failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const latest = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!latest) {
      selectedMessageId = null;
      selectedLatest = true;
      const info = await fetchMonitorInfo();
      statusEl.textContent =
        `No monitor data received. Send snapshots to ${info.ingest_host}:${info.ingest_port}.`;
    }

    if (selectedMessageId !== null && !messages.some(message => Number(message.id) === selectedMessageId)) {
      selectedMessageId = null;
      selectedLatest = true;
    }
    if (selectedLatest && latest) {
      const latestId = Number(latest.id);
      if (selectedMessageId !== latestId) {
        selectedMessageId = latestId;
        await loadSnapshot(latestId);
      }
    }

    if (data.version !== messageListVersion) {
      messageListVersion = data.version;
      renderMessageTree(messages);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  }
}

function setTool(tool) {
  viewer.setTool(tool);
  rotateModeButton.classList.toggle('active', tool === 'rotate');
  panModeButton.classList.toggle('active', tool === 'pan');
}

refreshMonitorButton.addEventListener('click', refreshMonitor);
clearMonitorButton.addEventListener('click', clearMonitor);
rotateModeButton.addEventListener('click', () => setTool('rotate'));
panModeButton.addEventListener('click', () => setTool('pan'));
resetViewButton.addEventListener('click', () => viewer.resetView());

refreshMessageList();
setInterval(refreshMessageList, 1000);
