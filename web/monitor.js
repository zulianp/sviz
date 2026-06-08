import { MeshViewer } from './viewer.js';

const canvas = document.getElementById('view');
const statusEl = document.getElementById('status');
const refreshMonitorButton = document.getElementById('refreshMonitor');
const rotateModeButton = document.getElementById('rotateMode');
const panModeButton = document.getElementById('panMode');
const resetViewButton = document.getElementById('resetView');

const viewer = new MeshViewer(canvas);
let monitorInfo = null;

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

function bindMonitorSnapshot(buffer) {
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
  statusEl.textContent = `${points.length / 3} points, ${quadCount} quads, ${vectorCount} vectors from monitor socket`;
}

async function refreshMonitor() {
  try {
    const response = await fetch('/monitor.bin?ts=' + Date.now());
    if (response.status === 204) {
      const info = await fetchMonitorInfo();
      statusEl.textContent =
        `No monitor data received. Send snapshots to ${info.ingest_host}:${info.ingest_port}.`;
      return;
    }
    if (!response.ok) {
      throw new Error(`monitor fetch failed with HTTP ${response.status}`);
    }
    bindMonitorSnapshot(await response.arrayBuffer());
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
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

function setTool(tool) {
  viewer.setTool(tool);
  rotateModeButton.classList.toggle('active', tool === 'rotate');
  panModeButton.classList.toggle('active', tool === 'pan');
}

refreshMonitorButton.addEventListener('click', refreshMonitor);
rotateModeButton.addEventListener('click', () => setTool('rotate'));
panModeButton.addEventListener('click', () => setTool('pan'));
resetViewButton.addEventListener('click', () => viewer.resetView());

refreshMonitor();
setInterval(refreshMonitor, 1000);
