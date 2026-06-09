export class MeshViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true });
    if (!this.gl) {
      throw new Error('WebGL is not available');
    }

    this.uintIndexExtension = this.gl.getExtension('OES_element_index_uint');
    this.mesh = null;
    this.activeTool = 'rotate';
    this.view = {
      rx: -0.55,
      ry: 0.75,
      panX: 0,
      panY: 0,
      distance: 3.0
    };
    this.pointers = new Map();
    this.dragStart = null;

    this.vertexBuffer = this.gl.createBuffer();
    this.triBuffer = this.gl.createBuffer();
    this.edgeBuffer = this.gl.createBuffer();
    this.vectorBuffer = this.gl.createBuffer();

    this.initProgram();
    this.installCanvasControls();
    requestAnimationFrame(() => this.frame());
  }

  initProgram() {
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

    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, this.shader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, this.shader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }

    this.program = program;
    this.position = gl.getAttribLocation(program, 'position');
    this.color = gl.getUniformLocation(program, 'color');
    this.mvp = gl.getUniformLocation(program, 'mvp');
    this.centerUniform = gl.getUniformLocation(program, 'center');
    this.scaleUniform = gl.getUniformLocation(program, 'scale');
  }

  shader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  bindRenderMesh({ vertices, triangles, edges, vectors = null }) {
    const gl = this.gl;
    const canUseUint32 = Boolean(this.uintIndexExtension);
    const maxIndex = Math.floor(vertices.length / 3) - 1;
    if (!canUseUint32 && maxIndex > 65535) {
      throw new Error('This browser only supports meshes up to 65535 vertices');
    }

    const IndexArray = canUseUint32 ? Uint32Array : Uint16Array;
    const indexType = canUseUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const triangleData = canUseUint32 ? triangles : new IndexArray(triangles);
    const edgeData = canUseUint32 ? edges : new IndexArray(edges);
    const bounds = boundsFromVertices(vertices);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangleData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edgeData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vectors || new Float32Array(0), gl.STATIC_DRAW);

    this.mesh = {
      center: bounds.center,
      scale: 1.55 / bounds.extent,
      triangleCount: triangles.length,
      edgeCount: edges.length,
      vectorVertexCount: vectors ? Math.floor(vectors.length / 3) : 0,
      indexType
    };
  }

  clear() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
    this.mesh = null;
  }

  setTool(tool) {
    this.activeTool = tool;
  }

  resetView() {
    this.view.rx = -0.55;
    this.view.ry = 0.75;
    this.view.panX = 0;
    this.view.panY = 0;
    this.view.distance = 3.0;
  }

  clampZoom() {
    this.view.distance = Math.min(30, Math.max(0.35, this.view.distance));
  }

  panBy(dx, dy) {
    const scale = this.view.distance / Math.max(260, this.canvas.clientHeight);
    this.view.panX += dx * scale;
    this.view.panY -= dy * scale;
  }

  rotateBy(dx, dy) {
    this.view.ry += dx * 0.008;
    this.view.rx += dy * 0.008;
    const limit = Math.PI * 0.49;
    this.view.rx = Math.min(limit, Math.max(-limit, this.view.rx));
  }

  beginPointer(event) {
    if (event.target !== this.canvas) {
      return;
    }
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.dragStart = null;

    if (this.pointers.size === 1) {
      this.dragStart = {
        x: event.clientX,
        y: event.clientY,
        tool: event.shiftKey || event.button === 2 ? 'pan' : this.activeTool
      };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.dragStart = {
        center: pointerCenter(a, b),
        distance: pointerDistance(a, b),
        cameraDistance: this.view.distance
      };
    }
  }

  movePointer(event) {
    if (!this.pointers.has(event.pointerId)) {
      return;
    }
    event.preventDefault();
    const prev = this.pointers.get(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 1 && this.dragStart) {
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      if (this.dragStart.tool === 'pan') {
        this.panBy(dx, dy);
      } else {
        this.rotateBy(dx, dy);
      }
    } else if (this.pointers.size === 2 && this.dragStart) {
      const [a, b] = [...this.pointers.values()];
      const center = pointerCenter(a, b);
      const currentDistance = pointerDistance(a, b);
      this.panBy(center.x - this.dragStart.center.x, center.y - this.dragStart.center.y);
      if (currentDistance > 0 && this.dragStart.distance > 0) {
        this.view.distance = this.dragStart.cameraDistance * this.dragStart.distance / currentDistance;
        this.clampZoom();
      }
      this.dragStart.center = center;
    }
  }

  endPointer(event) {
    this.pointers.delete(event.pointerId);
    this.dragStart = null;
    if (this.pointers.size === 1) {
      const [point] = [...this.pointers.values()];
      this.dragStart = { x: point.x, y: point.y, tool: this.activeTool };
    }
  }

  zoomWheel(event) {
    if (event.target !== this.canvas) {
      return;
    }
    event.preventDefault();
    this.view.distance *= Math.exp(event.deltaY * 0.001);
    this.clampZoom();
  }

  installCanvasControls() {
    this.canvas.addEventListener('pointerdown', event => this.beginPointer(event));
    this.canvas.addEventListener('pointermove', event => this.movePointer(event));
    this.canvas.addEventListener('pointerup', event => this.endPointer(event));
    this.canvas.addEventListener('pointercancel', event => this.endPointer(event));
    this.canvas.addEventListener('wheel', event => this.zoomWheel(event), { passive: false });
    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  transform() {
    const rx = this.view.rx;
    const ry = this.view.ry;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    return new Float32Array([
      cy, sx * sy, -cx * sy, 0,
      0, cx, sx, 0,
      sy, -sx * cy, cx * cy, 0,
      this.view.panX, this.view.panY, -this.view.distance, 1
    ]);
  }

  glCheck(label) {
    const err = this.gl.getError();
    if (err !== this.gl.NO_ERROR) {
      console.error(`${label}: WebGL error ${err}`);
    }
  }

  frame() {
    const gl = this.gl;
    this.resize();
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.063, 0.071, 0.086, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.mesh) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.enableVertexAttribArray(this.position);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(
        this.mvp,
        false,
        multiply(perspective(0.75, this.canvas.width / this.canvas.height, 0.1, 100), this.transform())
      );
      gl.uniform3f(this.centerUniform, this.mesh.center[0], this.mesh.center[1], this.mesh.center[2]);
      gl.uniform1f(this.scaleUniform, this.mesh.scale);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuffer);
      gl.uniform4f(this.color, 0.16, 0.58, 0.96, 0.82);
      gl.drawElements(gl.TRIANGLES, this.mesh.triangleCount, this.mesh.indexType, 0);

      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuffer);
      gl.uniform4f(this.color, 0.95, 0.98, 1.0, 1.0);
      gl.drawElements(gl.LINES, this.mesh.edgeCount, this.mesh.indexType, 0);

      if (this.mesh.vectorVertexCount > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer);
        gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
        gl.uniform4f(this.color, 1.0, 0.76, 0.24, 1.0);
        gl.drawArrays(gl.LINES, 0, this.mesh.vectorVertexCount);
      }

      gl.enable(gl.DEPTH_TEST);
      this.glCheck('draw');
    }

    requestAnimationFrame(() => this.frame());
  }
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

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCenter(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5
  };
}
