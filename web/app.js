const canvas = document.getElementById('view');
const form = document.getElementById('controls');
const titleEl = document.querySelector('h1');
const cubeViewButton = document.getElementById('cubeView');
const monitorViewButton = document.getElementById('monitorView');
const cubeControls = document.getElementById('cubeControls');
const monitorControls = document.getElementById('monitorControls');
const statusEl = document.getElementById('status');
const generateButton = document.getElementById('generate');
const refreshMonitorButton = document.getElementById('refreshMonitor');
const rotateModeButton = document.getElementById('rotateMode');
const panModeButton = document.getElementById('panMode');
const resetViewButton = document.getElementById('resetView');

const gl = canvas.getContext('webgl', { antialias: true });
if (!gl) {
  throw new Error('WebGL is not available');
}
const uintIndexExtension = gl.getExtension('OES_element_index_uint');

let wasm = null;
let mesh = null;
let activeView = 'cube';
let activeTool = 'rotate';
const view = {
  rx: -0.55,
  ry: 0.75,
  panX: 0,
  panY: 0,
  distance: 3.0
};
const pointers = new Map();
let dragStart = null;
const vertexBuffer = gl.createBuffer();
const triBuffer = gl.createBuffer();
const edgeBuffer = gl.createBuffer();
const vectorBuffer = gl.createBuffer();

const vertexSource = `
attribute vec3 position;
uniform mat4 mvp;
uniform vec3 center;
uniform float scale;
void main() {
  gl_Position = mvp * vec4((position - center) * scale, 1.0);
}`;

const fragmentSource = `
precision mediump float;
uniform vec4 color;
void main() { gl_FragColor = color; }`;

function shader(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}

const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program));
}

const position = gl.getAttribLocation(program, 'position');
const color = gl.getUniformLocation(program, 'color');
const mvp = gl.getUniformLocation(program, 'mvp');
const centerUniform = gl.getUniformLocation(program, 'center');
const scaleUniform = gl.getUniformLocation(program, 'scale');

function intValue(id) {
  const value = Math.floor(Number(document.getElementById(id).value));
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${id} must be a positive integer`);
  }
  return value;
}

function numberValue(id) {
  const value = Number(document.getElementById(id).value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${id} must be a positive number`);
  }
  return value;
}

async function loadWasm() {
  const loader = await import('/wasm/sviz_wasm.js');
  const createModule = loader.default || globalThis.createSvizWasmModule;
  wasm = await createModule({ locateFile: name => '/wasm/' + name });
}

function createCube(nx, ny, nz, sx, sy, sz) {
  if (!wasm) {
    throw new Error('WebAssembly is still loading');
  }

  const ok = wasm.ccall(
    'sviz_create_hex8_cube',
    'number',
    ['number', 'number', 'number', 'number', 'number', 'number'],
    [nx, ny, nz, sx, sy, sz]
  );
  if (!ok) {
    throw new Error('WASM cube generation failed');
  }

  const verticesPtr = wasm.ccall('sviz_vertices_ptr', 'number', [], []);
  const trianglesPtr = wasm.ccall('sviz_triangles_ptr', 'number', [], []);
  const edgesPtr = wasm.ccall('sviz_edges_ptr', 'number', [], []);
  const vertexCount = wasm.ccall('sviz_vertex_count', 'number', [], []);
  const triangleIndexCount = wasm.ccall('sviz_triangle_index_count', 'number', [], []);
  const edgeIndexCount = wasm.ccall('sviz_edge_index_count', 'number', [], []);
  const nodes = wasm.ccall('sviz_node_count', 'number', [], []);
  const elements = wasm.ccall('sviz_element_count', 'number', [], []);

  if (!verticesPtr || !trianglesPtr || !edgesPtr) {
    throw new Error('WASM mesh buffers are not available');
  }

  return {
    verticesPtr,
    trianglesPtr,
    edgesPtr,
    vertexCount,
    triangleIndexCount,
    edgeIndexCount,
    nodes,
    elements
  };
}

function boundsFromVertices(vertices) {
  if (vertices.length < 3) {
    throw new Error('mesh has no vertices');
  }
  let minX = vertices[0], minY = vertices[1], minZ = vertices[2];
  let maxX = minX, maxY = minY, maxZ = minZ;
  for (let i = 3; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    extent: Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6)
  };
}

function bindRenderMesh({ vertices, triangles, edges, vectors = null }) {
  const canUseUint32 = Boolean(uintIndexExtension);
  const maxIndex = Math.floor(vertices.length / 3) - 1;
  if (!canUseUint32 && maxIndex > 65535) {
    throw new Error('This browser only supports meshes up to 65535 vertices');
  }

  const IndexArray = canUseUint32 ? Uint32Array : Uint16Array;
  const indexType = canUseUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  const triangleData = canUseUint32 ? triangles : new IndexArray(triangles);
  const edgeData = canUseUint32 ? edges : new IndexArray(edges);
  const bounds = boundsFromVertices(vertices);

  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangleData, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edgeData, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, vectorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vectors || new Float32Array(0), gl.STATIC_DRAW);

  mesh = {
    center: bounds.center,
    scale: 1.55 / bounds.extent,
    triangleCount: triangles.length,
    edgeCount: edges.length,
    vectorVertexCount: vectors ? Math.floor(vectors.length / 3) : 0,
    indexType
  };
}

function bindCubeMesh(data) {
  const vertices = new Float32Array(
    wasm.HEAPF32.buffer,
    data.verticesPtr,
    data.vertexCount * 3
  );
  const triangles = new Uint32Array(
    wasm.HEAPU32.buffer,
    data.trianglesPtr,
    data.triangleIndexCount
  );
  const edges = new Uint32Array(
    wasm.HEAPU32.buffer,
    data.edgesPtr,
    data.edgeIndexCount
  );
  bindRenderMesh({ vertices, triangles, edges });
}

function regenerate() {
  generateButton.disabled = true;
  try {
    const nx = intValue('nx');
    const ny = intValue('ny');
    const nz = intValue('nz');
    const sx = numberValue('sx');
    const sy = numberValue('sy');
    const sz = numberValue('sz');
    const data = createCube(nx, ny, nz, sx, sy, sz);
    bindCubeMesh(data);
    statusEl.textContent = `${data.nodes} nodes, ${data.elements} HEX8 elements generated in WebAssembly`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  } finally {
    generateButton.disabled = false;
  }
}

function findYamlEnd(bytes) {
  for (let i = 0; i + 4 < bytes.length; ++i) {
    if (
      bytes[i] === 10 &&
      bytes[i + 1] === 46 &&
      bytes[i + 2] === 46 &&
      bytes[i + 3] === 46 &&
      bytes[i + 4] === 10
    ) {
      return { headerEnd: i + 5, textEnd: i };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 46 && bytes[1] === 46 && bytes[2] === 46 && bytes[3] === 10) {
    return { headerEnd: 4, textEnd: 0 };
  }
  throw new Error('monitor snapshot is missing YAML document end marker');
}

function parseYamlValue(value) {
  const text = value.trim();
  if (text === '') {
    return {};
  }
  if (/^-?\d+$/.test(text)) {
    return Number(text);
  }
  if (/^-?(\d+\.\d*|\d*\.\d+)(e[-+]?\d+)?$/i.test(text)) {
    return Number(text);
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  return text.replace(/^['"]|['"]$/g, '');
}

function parseMonitorYaml(text) {
  const root = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = parseYamlValue(line.slice(colon + 1));
    if (indent === 0) {
      root[key] = value;
      section = typeof value === 'object' ? key : null;
    } else if (section) {
      root[section][key] = value;
    }
  }
  return root;
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
  const yamlEnd = findYamlEnd(bytes);
  const headerText = new TextDecoder().decode(bytes.subarray(0, yamlEnd.textEnd));
  const header = parseMonitorYaml(headerText);
  if (header.sviz_protocol !== 1) {
    throw new Error('unsupported monitor protocol');
  }
  if (header.endianness && header.endianness !== 'little') {
    throw new Error('only little-endian monitor payloads are supported');
  }

  const points = typedPayloadView(Float32Array, bytes, yamlEnd.headerEnd, header.points);
  const quads = typedPayloadView(Uint32Array, bytes, yamlEnd.headerEnd, header.quads);
  const vectors = header.vectors
    ? typedPayloadView(Float32Array, bytes, yamlEnd.headerEnd, header.vectors)
    : null;
  const vectorScale = Number(header.vector_scale || 1);
  bindRenderMesh({
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
  if (activeView !== 'monitor') {
    return;
  }
  try {
    const response = await fetch('/monitor.bin?ts=' + Date.now());
    if (response.status === 204) {
      statusEl.textContent = 'No monitor data received';
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

function multiply(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; ++c) {
    for (let row = 0; row < 4; ++row) {
      r[c * 4 + row] =
        a[row] * b[c * 4] +
        a[4 + row] * b[c * 4 + 1] +
        a[8 + row] * b[c * 4 + 2] +
        a[12 + row] * b[c * 4 + 3];
    }
  }
  return r;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

function transform() {
  const rx = view.rx;
  const ry = view.ry;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  return new Float32Array([
    cy, sx * sy, -cx * sy, 0,
    0, cx, sx, 0,
    sy, -sx * cy, cx * cy, 0,
    view.panX, view.panY, -view.distance, 1
  ]);
}

function resetView() {
  view.rx = -0.55;
  view.ry = 0.75;
  view.panX = 0;
  view.panY = 0;
  view.distance = 3.0;
}

function setTool(tool) {
  activeTool = tool;
  rotateModeButton.classList.toggle('active', tool === 'rotate');
  panModeButton.classList.toggle('active', tool === 'pan');
}

function clampZoom() {
  view.distance = Math.min(30, Math.max(0.35, view.distance));
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCenter(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5
  };
}

function panBy(dx, dy) {
  const scale = view.distance / Math.max(260, canvas.clientHeight);
  view.panX += dx * scale;
  view.panY -= dy * scale;
}

function rotateBy(dx, dy) {
  view.ry += dx * 0.008;
  view.rx += dy * 0.008;
  const limit = Math.PI * 0.49;
  view.rx = Math.min(limit, Math.max(-limit, view.rx));
}

function beginPointer(event) {
  if (event.target !== canvas) {
    return;
  }
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragStart = null;

  if (pointers.size === 1) {
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      tool: event.shiftKey || event.button === 2 ? 'pan' : activeTool
    };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    dragStart = {
      center: pointerCenter(a, b),
      distance: pointerDistance(a, b),
      cameraDistance: view.distance
    };
  }
}

function movePointer(event) {
  if (!pointers.has(event.pointerId)) {
    return;
  }
  event.preventDefault();
  const prev = pointers.get(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 1 && dragStart) {
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    if (dragStart.tool === 'pan') {
      panBy(dx, dy);
    } else {
      rotateBy(dx, dy);
    }
  } else if (pointers.size === 2 && dragStart) {
    const [a, b] = [...pointers.values()];
    const center = pointerCenter(a, b);
    const currentDistance = pointerDistance(a, b);
    panBy(center.x - dragStart.center.x, center.y - dragStart.center.y);
    if (currentDistance > 0 && dragStart.distance > 0) {
      view.distance = dragStart.cameraDistance * dragStart.distance / currentDistance;
      clampZoom();
    }
    dragStart.center = center;
  }
}

function endPointer(event) {
  pointers.delete(event.pointerId);
  dragStart = null;
  if (pointers.size === 1) {
    const [point] = [...pointers.values()];
    dragStart = { x: point.x, y: point.y, tool: activeTool };
  }
}

function zoomWheel(event) {
  if (event.target !== canvas) {
    return;
  }
  event.preventDefault();
  view.distance *= Math.exp(event.deltaY * 0.001);
  clampZoom();
}

function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function glCheck(label) {
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    console.error(`${label}: WebGL error ${err}`);
  }
}

function frame() {
  resize();
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.063, 0.071, 0.086, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (mesh) {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(
      mvp,
      false,
      multiply(perspective(0.75, canvas.width / canvas.height, 0.1, 100), transform())
    );
    gl.uniform3f(centerUniform, mesh.center[0], mesh.center[1], mesh.center[2]);
    gl.uniform1f(scaleUniform, mesh.scale);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuffer);
    gl.uniform4f(color, 0.16, 0.58, 0.96, 0.82);
    gl.drawElements(gl.TRIANGLES, mesh.triangleCount, mesh.indexType, 0);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
    gl.uniform4f(color, 0.95, 0.98, 1.0, 1.0);
    gl.drawElements(gl.LINES, mesh.edgeCount, mesh.indexType, 0);

    if (mesh.vectorVertexCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vectorBuffer);
      gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(color, 1.0, 0.76, 0.24, 1.0);
      gl.drawArrays(gl.LINES, 0, mesh.vectorVertexCount);
    }

    gl.enable(gl.DEPTH_TEST);
    glCheck('draw');
  }

  requestAnimationFrame(frame);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (activeView === 'cube') {
    regenerate();
  }
});

function setView(viewName) {
  activeView = viewName;
  const cube = viewName === 'cube';
  cubeViewButton.classList.toggle('active', cube);
  monitorViewButton.classList.toggle('active', !cube);
  cubeControls.classList.toggle('hidden', !cube);
  monitorControls.classList.toggle('hidden', cube);
  titleEl.textContent = cube ? 'SVIZ Hex8 Cube' : 'SVIZ Monitor';
  if (cube) {
    regenerate();
  } else {
    refreshMonitor();
  }
}

cubeViewButton.addEventListener('click', () => setView('cube'));
monitorViewButton.addEventListener('click', () => setView('monitor'));
refreshMonitorButton.addEventListener('click', refreshMonitor);
rotateModeButton.addEventListener('click', () => setTool('rotate'));
panModeButton.addEventListener('click', () => setTool('pan'));
resetViewButton.addEventListener('click', resetView);
canvas.addEventListener('pointerdown', beginPointer);
canvas.addEventListener('pointermove', movePointer);
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', zoomWheel, { passive: false });
canvas.addEventListener('contextmenu', event => event.preventDefault());

loadWasm()
  .then(() => {
    generateButton.disabled = false;
    if (activeView === 'cube') {
      regenerate();
    }
  })
  .catch(err => {
    console.error(err);
    generateButton.disabled = true;
    statusEl.textContent = err.message;
  });

requestAnimationFrame(frame);
setInterval(refreshMonitor, 1000);
