import { MeshViewer } from './viewer.js';

const canvas = document.getElementById('view');
const form = document.getElementById('controls');
const statusEl = document.getElementById('status');
const generateButton = document.getElementById('generate');
const rotateModeButton = document.getElementById('rotateMode');
const panModeButton = document.getElementById('panMode');
const resetViewButton = document.getElementById('resetView');

const viewer = new MeshViewer(canvas);
let wasm = null;

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
  viewer.bindRenderMesh({ vertices, triangles, edges });
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

function setTool(tool) {
  viewer.setTool(tool);
  rotateModeButton.classList.toggle('active', tool === 'rotate');
  panModeButton.classList.toggle('active', tool === 'pan');
}

form.addEventListener('submit', event => {
  event.preventDefault();
  regenerate();
});
rotateModeButton.addEventListener('click', () => setTool('rotate'));
panModeButton.addEventListener('click', () => setTool('pan'));
resetViewButton.addEventListener('click', () => viewer.resetView());

loadWasm()
  .then(() => {
    generateButton.disabled = false;
    regenerate();
  })
  .catch(err => {
    console.error(err);
    generateButton.disabled = true;
    statusEl.textContent = err.message;
  });
