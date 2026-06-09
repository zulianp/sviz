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
let currentMessages = [];
let visibleMessageIds = new Set();
let snapshotCache = new Map();
let playingAnimation = null;

const ANIMATION_INTERVAL_MS = 300;

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

function hexaBoundaryQuads(hexas) {
  const faces = new Map();
  const facePattern = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7]
  ];

  for (let h = 0; h < hexas.length; h += 8) {
    for (const pattern of facePattern) {
      const face = pattern.map(local => hexas[h + local]);
      const key = [...face].sort((a, b) => a - b).join(':');
      const entry = faces.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        faces.set(key, { count: 1, face });
      }
    }
  }

  const quads = [];
  for (const entry of faces.values()) {
    if (entry.count === 1) {
      quads.push(...entry.face);
    }
  }
  return new Uint32Array(quads);
}

function concatUint32Arrays(a, b) {
  if (!a || a.length === 0) {
    return b || new Uint32Array(0);
  }
  if (!b || b.length === 0) {
    return a;
  }
  const out = new Uint32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatFloat32Arrays(a, b) {
  if (!a || a.length === 0) {
    return b || new Float32Array(0);
  }
  if (!b || b.length === 0) {
    return a;
  }
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function offsetUint32Array(values, offset) {
  if (!values || values.length === 0 || offset === 0) {
    return values || new Uint32Array(0);
  }
  const out = new Uint32Array(values.length);
  for (let i = 0; i < values.length; ++i) {
    out[i] = values[i] + offset;
  }
  return out;
}

function aabbVertices(aabbs) {
  const vertices = new Float32Array((aabbs.length / 6) * 8 * 3);
  for (let i = 0, out = 0; i < aabbs.length; i += 6) {
    const xmin = aabbs[i];
    const ymin = aabbs[i + 1];
    const zmin = aabbs[i + 2];
    const xmax = aabbs[i + 3];
    const ymax = aabbs[i + 4];
    const zmax = aabbs[i + 5];
    const corners = [
      xmin, ymin, zmin,
      xmax, ymin, zmin,
      xmax, ymax, zmin,
      xmin, ymax, zmin,
      xmin, ymin, zmax,
      xmax, ymin, zmax,
      xmax, ymax, zmax,
      xmin, ymax, zmax
    ];
    vertices.set(corners, out);
    out += corners.length;
  }
  return vertices;
}

function aabbEdges(aabbCount, vertexOffset) {
  const pattern = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const edges = new Uint32Array(aabbCount * pattern.length);
  for (let i = 0, out = 0; i < aabbCount; ++i) {
    const base = vertexOffset + i * 8;
    for (const local of pattern) {
      edges[out++] = base + local;
    }
  }
  return edges;
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

function decodeMonitorSnapshot(buffer, label = 'monitor socket') {
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

  const points = header.points
    ? typedPayloadView(Float32Array, bytes, jsonEnd.headerEnd, header.points)
    : new Float32Array(0);
  const explicitQuads = header.quads
    ? typedPayloadView(Uint32Array, bytes, jsonEnd.headerEnd, header.quads)
    : new Uint32Array(0);
  const hexas = header.hexas
    ? typedPayloadView(Uint32Array, bytes, jsonEnd.headerEnd, header.hexas)
    : new Uint32Array(0);
  const aabbs = header.aabbs
    ? typedPayloadView(Float32Array, bytes, jsonEnd.headerEnd, header.aabbs)
    : new Float32Array(0);
  const aabbVerts = aabbVertices(aabbs);
  const vertices = concatFloat32Arrays(points, aabbVerts);
  const quads = concatUint32Arrays(explicitQuads, hexaBoundaryQuads(hexas));
  const edges = concatUint32Arrays(
    quadEdges(quads),
    aabbEdges(Math.floor(aabbs.length / 6), Math.floor(points.length / 3))
  );
  const vectors = header.vectors
    ? typedPayloadView(Float32Array, bytes, jsonEnd.headerEnd, header.vectors)
    : null;
  const vectorScale = Number(header.vector_scale || 1);
  const triangles = quadTriangles(quads);
  const vectorSegmentsData = vectors ? vectorSegments(vectors, vectorScale) : null;

  const quadCount = header.quads ? Number(header.quads.count) : 0;
  const hexaCount = header.hexas ? Number(header.hexas.count) : 0;
  const aabbCount = header.aabbs ? Number(header.aabbs.count) : 0;
  const boundaryQuadCount = Math.floor(quads.length / 4);
  const vectorCount = vectors ? Math.floor(vectors.length / 6) : 0;
  return {
    label,
    header,
    vertices,
    triangles,
    edges,
    vectors: vectorSegmentsData,
    counts: {
      points: Math.floor(points.length / 3),
      quads: quadCount,
      hexas: hexaCount,
      aabbs: aabbCount,
      renderedFaces: boundaryQuadCount,
      vectors: vectorCount
    }
  };
}

function composeGeometries(geometries) {
  let vertexItems = 0;
  let triangleItems = 0;
  let edgeItems = 0;
  let vectorItems = 0;
  for (const geometry of geometries) {
    vertexItems += geometry.vertices.length;
    triangleItems += geometry.triangles.length;
    edgeItems += geometry.edges.length;
    vectorItems += geometry.vectors ? geometry.vectors.length : 0;
  }

  const vertices = new Float32Array(vertexItems);
  const triangles = new Uint32Array(triangleItems);
  const edges = new Uint32Array(edgeItems);
  const vectors = vectorItems > 0 ? new Float32Array(vectorItems) : null;

  let vertexOffset = 0;
  let vertexIndexOffset = 0;
  let triangleOffset = 0;
  let edgeOffset = 0;
  let vectorOffset = 0;
  for (const geometry of geometries) {
    vertices.set(geometry.vertices, vertexOffset);
    const shiftedTriangles = offsetUint32Array(geometry.triangles, vertexIndexOffset);
    const shiftedEdges = offsetUint32Array(geometry.edges, vertexIndexOffset);
    triangles.set(shiftedTriangles, triangleOffset);
    edges.set(shiftedEdges, edgeOffset);
    if (vectors && geometry.vectors) {
      vectors.set(geometry.vectors, vectorOffset);
      vectorOffset += geometry.vectors.length;
    }
    vertexOffset += geometry.vertices.length;
    vertexIndexOffset += Math.floor(geometry.vertices.length / 3);
    triangleOffset += geometry.triangles.length;
    edgeOffset += geometry.edges.length;
  }

  return { vertices, triangles, edges, vectors };
}

function composeCounts(geometries) {
  const counts = {
    points: 0,
    quads: 0,
    hexas: 0,
    aabbs: 0,
    renderedFaces: 0,
    vectors: 0
  };
  for (const geometry of geometries) {
    counts.points += geometry.counts.points;
    counts.quads += geometry.counts.quads;
    counts.hexas += geometry.counts.hexas;
    counts.aabbs += geometry.counts.aabbs;
    counts.renderedFaces += geometry.counts.renderedFaces;
    counts.vectors += geometry.counts.vectors;
  }
  return counts;
}

async function fetchSnapshotGeometry(id) {
  const numericId = Number(id);
  if (snapshotCache.has(numericId)) {
    return snapshotCache.get(numericId);
  }
  const params = new URLSearchParams({ id: String(numericId), ts: String(Date.now()) });
  const response = await fetch('/monitor.bin?' + params.toString());
  if (!response.ok) {
    throw new Error(`monitor fetch failed with HTTP ${response.status}`);
  }
  const geometry = decodeMonitorSnapshot(await response.arrayBuffer(), `snapshot ${numericId}`);
  snapshotCache.set(numericId, geometry);
  return geometry;
}

function visibleMessagesInOrder(messages) {
  return messages
    .filter(message => visibleMessageIds.has(Number(message.id)))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
}

async function renderVisibleMessages(messages = currentMessages) {
  try {
    const visibleMessages = visibleMessagesInOrder(messages);
    if (visibleMessages.length === 0) {
      viewer.clear();
      statusEl.textContent = messages.length === 0
        ? 'No retained messages'
        : 'No visible messages';
      return;
    }

    const geometries = await Promise.all(
      visibleMessages.map(message => fetchSnapshotGeometry(Number(message.id)))
    );
    const composed = composeGeometries(geometries);
    if (composed.vertices.length === 0) {
      viewer.clear();
      statusEl.textContent = 'Visible messages have no vertices';
      return;
    }
    viewer.bindRenderMesh(composed);

    const counts = composeCounts(geometries);
    const labels = visibleMessages.map(message => message.name || 'monitor').join(', ');
    statusEl.textContent =
      `${visibleMessages.length} visible: ${counts.points} points, ${counts.quads} quads, ${counts.hexas} hexas, ${counts.aabbs} AABBs, ${counts.renderedFaces} rendered faces, ${counts.vectors} vectors (${labels})`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  }
}

function showOnlySnapshot(id) {
  selectedLatest = false;
  selectedMessageId = Number(id);
  visibleMessageIds = new Set([selectedMessageId]);
  stopAnimation(false);
  renderMessageTree(currentMessages);
  renderVisibleMessages(currentMessages);
}

async function refreshMonitor() {
  selectedLatest = true;
  selectedMessageId = null;
  stopAnimation(false);
  messageListVersion = -1;
  await refreshMessageList(true);
}

async function clearMonitor() {
  clearMonitorButton.disabled = true;
  try {
    const response = await fetch('/monitor-clear', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`monitor clear failed with HTTP ${response.status}`);
    }
    stopAnimation(false);
    selectedLatest = true;
    selectedMessageId = null;
    messageListVersion = -1;
    currentMessages = [];
    visibleMessageIds = new Set();
    snapshotCache.clear();
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
    const animation = (message.animation || '').trim();
    const name = message.name || 'monitor';
    const key = animation ? `animation:${animation}` : `name:${name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: animation || name,
        animation: Boolean(animation),
        snapshots: []
      });
    }
    groups.get(key).snapshots.push(message);
  }
  for (const group of groups.values()) {
    group.snapshots.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.animation !== b.animation) {
      return a.animation ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });
}

function snapshotText(snapshot) {
  const quadText = Number(snapshot.quads) > 0 ? `${snapshot.quads} quads` : '';
  const hexaText = Number(snapshot.hexas) > 0 ? `${snapshot.hexas} hexas` : '';
  const aabbText = Number(snapshot.aabbs) > 0 ? `${snapshot.aabbs} AABBs` : '';
  const vectorText = Number(snapshot.vectors) > 0 ? `${snapshot.vectors} vectors` : '';
  const pieces = [quadText, hexaText, aabbText, vectorText].filter(Boolean);
  return `t${snapshot.sequence}: ${pieces.length ? pieces.join(', ') : `${snapshot.points} points`}`;
}

function stopAnimation(render = true) {
  if (playingAnimation && playingAnimation.timer) {
    window.clearInterval(playingAnimation.timer);
  }
  playingAnimation = null;
  if (render) {
    renderMessageTree(currentMessages);
  }
}

function startAnimation(group) {
  const ids = group.snapshots.map(snapshot => Number(snapshot.id));
  if (ids.length === 0) {
    return;
  }
  stopAnimation(false);
  selectedLatest = false;
  playingAnimation = {
    key: group.key,
    ids,
    index: 0,
    timer: null
  };

  const advance = () => {
    if (!playingAnimation || playingAnimation.key !== group.key) {
      return;
    }
    const id = playingAnimation.ids[playingAnimation.index];
    visibleMessageIds = new Set([id]);
    selectedMessageId = id;
    playingAnimation.index = (playingAnimation.index + 1) % playingAnimation.ids.length;
    renderMessageTree(currentMessages);
    renderVisibleMessages(currentMessages);
  };
  advance();
  playingAnimation.timer = window.setInterval(advance, ANIMATION_INTERVAL_MS);
  renderMessageTree(currentMessages);
}

function toggleSnapshotVisibility(id) {
  stopAnimation(false);
  selectedLatest = false;
  selectedMessageId = Number(id);
  if (visibleMessageIds.has(selectedMessageId)) {
    visibleMessageIds.delete(selectedMessageId);
  } else {
    visibleMessageIds.add(selectedMessageId);
  }
  renderMessageTree(currentMessages);
  renderVisibleMessages(currentMessages);
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

  for (const group of groupMessages(messages)) {
    const details = document.createElement('details');
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent =
      `${group.animation ? 'Animation ' : ''}${group.title} (${group.snapshots.length})`;
    details.appendChild(summary);

    if (group.animation) {
      const groupActions = document.createElement('div');
      groupActions.className = 'group-actions';
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'secondary';
      const isPlaying = playingAnimation && playingAnimation.key === group.key;
      playButton.textContent = isPlaying ? 'Stop Animation' : 'Play Animation';
      playButton.addEventListener('click', event => {
        event.stopPropagation();
        if (isPlaying) {
          stopAnimation();
        } else {
          startAnimation(group);
        }
      });
      groupActions.appendChild(playButton);
      details.appendChild(groupActions);
    }

    const list = document.createElement('div');
    list.className = 'message-list';
    for (const snapshot of group.snapshots) {
      const id = Number(snapshot.id);
      const row = document.createElement('div');
      row.className = 'message-row';

      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = 'visibility-button';
      const isVisible = visibleMessageIds.has(id);
      visibility.textContent = isVisible ? 'Hide' : 'Show';
      visibility.classList.toggle('visible', isVisible);
      visibility.addEventListener('click', event => {
        event.stopPropagation();
        toggleSnapshotVisibility(id);
      });

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'message-item';
      if (id === selectedMessageId) {
        item.classList.add('active');
      }
      item.textContent = snapshotText(snapshot);
      item.addEventListener('click', () => {
        showOnlySnapshot(id);
      });
      row.appendChild(visibility);
      row.appendChild(item);
      list.appendChild(row);
    }
    details.appendChild(list);
    messageTreeEl.appendChild(details);
  }
}

async function refreshMessageList(forceRender = false) {
  try {
    const response = await fetch('/monitor-list.json?ts=' + Date.now());
    if (!response.ok) {
      throw new Error(`monitor list fetch failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    currentMessages = messages;
    const latest = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!latest) {
      selectedMessageId = null;
      selectedLatest = true;
      visibleMessageIds = new Set();
      stopAnimation(false);
      viewer.clear();
      if (data.version !== messageListVersion || forceRender) {
        messageListVersion = data.version;
        renderMessageTree(messages);
      }
      const info = await fetchMonitorInfo();
      statusEl.textContent =
        `No monitor data received. Send snapshots to ${info.ingest_host}:${info.ingest_port}.`;
      return;
    }

    let visibilityChanged = false;
    const retainedIds = new Set(messages.map(message => Number(message.id)));
    for (const id of [...visibleMessageIds]) {
      if (!retainedIds.has(id)) {
        visibleMessageIds.delete(id);
        visibilityChanged = true;
      }
    }
    if (selectedMessageId !== null && !messages.some(message => Number(message.id) === selectedMessageId)) {
      selectedMessageId = null;
      selectedLatest = true;
    }
    if (selectedLatest && latest) {
      const latestId = Number(latest.id);
      if (selectedMessageId !== latestId || visibleMessageIds.size !== 1 || !visibleMessageIds.has(latestId)) {
        selectedMessageId = latestId;
        visibleMessageIds = new Set([latestId]);
        visibilityChanged = true;
      }
    }

    const listChanged = data.version !== messageListVersion;
    if (listChanged || forceRender) {
      messageListVersion = data.version;
      renderMessageTree(messages);
    }
    if (visibilityChanged || listChanged || forceRender) {
      await renderVisibleMessages(messages);
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
