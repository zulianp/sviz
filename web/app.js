const canvas = document.getElementById('view');
const form = document.getElementById('controls');
const statusEl = document.getElementById('status');
const generateButton = document.getElementById('generate');

const gl = canvas.getContext('webgl', { antialias: true });
if (!gl) {
  throw new Error('WebGL is not available');
}
const uintIndexExtension = gl.getExtension('OES_element_index_uint');

let wasm = null;
let mesh = null;
const vertexBuffer = gl.createBuffer();
const triBuffer = gl.createBuffer();
const edgeBuffer = gl.createBuffer();

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

function bindMesh(data) {
  const vertices = new Float32Array(
    wasm.HEAPF32.buffer,
    data.verticesPtr,
    data.vertexCount * 3
  );
  const canUseUint32 = Boolean(uintIndexExtension);
  if (!canUseUint32 && data.nodes > 65535) {
    throw new Error('This browser only supports meshes up to 65535 nodes');
  }

  const IndexArray = canUseUint32 ? Uint32Array : Uint16Array;
  const indexType = canUseUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  const triangles32 = new Uint32Array(
    wasm.HEAPU32.buffer,
    data.trianglesPtr,
    data.triangleIndexCount
  );
  const edges32 = new Uint32Array(
    wasm.HEAPU32.buffer,
    data.edgesPtr,
    data.edgeIndexCount
  );
  const triangles = canUseUint32 ? triangles32 : new IndexArray(triangles32);
  const edges = canUseUint32 ? edges32 : new IndexArray(edges32);

  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangles, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);

  const sx = numberValue('sx');
  const sy = numberValue('sy');
  const sz = numberValue('sz');
  mesh = {
    center: [sx * 0.5, sy * 0.5, sz * 0.5],
    scale: 1.55 / Math.max(sx, sy, sz),
    triangleCount: data.triangleIndexCount,
    edgeCount: data.edgeIndexCount,
    indexType
  };
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
    bindMesh(data);
    statusEl.textContent = `${data.nodes} nodes, ${data.elements} HEX8 elements generated in WebAssembly`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  } finally {
    generateButton.disabled = false;
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

function transform(rx, ry) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  return new Float32Array([
    cy, sx * sy, -cx * sy, 0,
    0, cx, sx, 0,
    sy, -sx * cy, cx * cy, 0,
    0, 0, -3.0, 1
  ]);
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

function frame(time) {
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
      multiply(perspective(0.75, canvas.width / canvas.height, 0.1, 100), transform(-0.55, time * 0.00035))
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
    gl.enable(gl.DEPTH_TEST);
    glCheck('draw');
  }

  requestAnimationFrame(frame);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  regenerate();
});

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

requestAnimationFrame(frame);
