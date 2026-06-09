# sviz
Simple Mesh Visualizer/Manipulator for SFEM

## Tool Environment

Install the repo-local toolchain:

```sh
./scripts/setup_tools.sh
```

Activate it in the current shell:

```sh
. scripts/env.sh
```

Build the native server and WebAssembly module:

```sh
./scripts/build_all.sh
```

Run the server:

```sh
./build/sviz_server 8080 8081
```

Open `http://127.0.0.1:8080` for the cube generator, or
`http://127.0.0.1:8080/monitor` for the monitor app. The server serves the
browser clients and the generated WASM artifacts from `build-wasm/`. Mesh
generation happens in the browser through `smesh::Mesh` compiled to WebAssembly.

The first port is HTTP. The second port is the monitor ingest socket. If the
second port is omitted, the server uses `http_port + 1`.

## Monitor Protocol

External tools can send monitor meshes to the server through the monitor ingest
TCP socket. The browser Monitor view retains received messages and exposes them
through a left-side tree grouped by message name, with each retained snapshot
available as a temporal child entry.
Messages can also opt into an animation node; snapshots with the same animation
name are grouped in the browser and can be played in send order. Each retained
message has a visibility control, so multiple snapshots can be displayed at the
same time.

Each socket message is:

```text
<single-line JSON header as UTF-8>
<binary payload>
```

The newline after the JSON document terminates the header. The header must
declare `binary_bytes`, and the sender must send exactly that many binary bytes
after the newline. Numeric payloads are little-endian.

Current monitor fields:

```json
{"sviz_protocol":1,"kind":"monitor","name":"quad-vector-example","endianness":"little","animation":"solver-steps","binary_bytes":1400,"vector_scale":0.35,"points":{"dtype":"float32","components":3,"count":30,"offset":0},"quads":{"dtype":"uint32","components":4,"count":20,"offset":360},"vectors":{"dtype":"float32","components":6,"count":30,"offset":680}}
```

To clear all retained monitor messages, send a clear header with no payload:

```json
{"sviz_protocol":1,"kind":"clear","binary_bytes":0}
```

Payload sections:

- `points`: `count * 3` float32 values, stored as `x, y, z`.
- `quads`: `count * 4` uint32 values, stored as node indices `a, b, c, d`.
- `hexas`: optional `count * 8` uint32 values, stored as HEX8 node indices.
  The monitor viewer extracts and renders boundary faces.
- `aabbs`: optional `count * 6` float32 values, stored as
  `xmin, ymin, zmin, xmax, ymax, zmax`. The monitor viewer renders them as
  wireframe boxes.
- `vectors`: optional `count * 6` float32 values, stored as positioned vectors
  `x, y, z, vx, vy, vz`.

## Monitor C++ Client

Other C++ applications can send monitor snapshots with the self-contained
header-only client in `src/sviz_monitor_client.hpp`. It has no dependencies
beyond the C++ standard library and system sockets. On Windows, link the
application with `Ws2_32`.

Send a quad mesh from SoA streams:

```cpp
#include "sviz_monitor_client.hpp"

float x[num_points], y[num_points], z[num_points];
uint32_t a[num_quads], b[num_quads], c[num_quads], d[num_quads];

sviz::Message msg("my-mesh");
msg.quad_mesh_soa(
    sviz::view(x, num_points),
    sviz::view(y, num_points),
    sviz::view(z, num_points),
    sviz::view(a, num_quads),
    sviz::view(b, num_quads),
    sviz::view(c, num_quads),
    sviz::view(d, num_quads));

sviz::Client("127.0.0.1", 8081).send(msg);
```

Send a HEX8 mesh from SoA streams:

```cpp
sviz::Message msg("my-hex-mesh");
msg.hexa_mesh_soa(
    sviz::view(x, num_points),
    sviz::view(y, num_points),
    sviz::view(z, num_points),
    sviz::view(h0, num_hexas),
    sviz::view(h1, num_hexas),
    sviz::view(h2, num_hexas),
    sviz::view(h3, num_hexas),
    sviz::view(h4, num_hexas),
    sviz::view(h5, num_hexas),
    sviz::view(h6, num_hexas),
    sviz::view(h7, num_hexas));

sviz::Client("127.0.0.1", 8081).send(msg);
```

Send axis-aligned bounding boxes:

```cpp
sviz::Message msg("bvh-boxes");
msg.aabb_soa(
    sviz::view(xmin, num_boxes),
    sviz::view(ymin, num_boxes),
    sviz::view(zmin, num_boxes),
    sviz::view(xmax, num_boxes),
    sviz::view(ymax, num_boxes),
    sviz::view(zmax, num_boxes));

sviz::Client("127.0.0.1", 8081).send(msg);
```

Send quivers from SoA streams:

```cpp
sviz::Message msg("velocity");
msg.set_vector_scale(0.1)
   .quivers_soa(
       sviz::view(x, n),
       sviz::view(y, n),
       sviz::view(z, n),
       sviz::view(vx, n),
       sviz::view(vy, n),
       sviz::view(vz, n));

sviz::Client().send(msg);
```

Send animation frames:

```cpp
sviz::Client client("127.0.0.1", 8081);
for (int frame = 0; frame < num_frames; ++frame) {
    sviz::Message msg("deformed-frame");
    msg.animation_node("deformation")
       .quad_mesh_soa(
           sviz::view(x[frame], num_points),
           sviz::view(y[frame], num_points),
           sviz::view(z[frame], num_points),
           sviz::view(a, num_quads),
           sviz::view(b, num_quads),
           sviz::view(c, num_quads),
           sviz::view(d, num_quads));
    client.send(msg);
}
```

Clear the retained monitor messages:

```cpp
sviz::Client("127.0.0.1", 8081).clear();
// or
sviz::send_clear("127.0.0.1", 8081);
```

`view(data, count, stride)` also supports strided SoA fields. Interleaved
helpers are available as `points_interleaved`, `quads_interleaved`,
`hexas_interleaved`, `aabb_interleaved`, `quad_mesh_interleaved`,
`hexa_mesh_interleaved`, and `quivers_interleaved`.

For SMesh/SFEM surfaces, use the optional adapter instead of creating new
owning buffers from `data()`:

```cpp
#include "sviz_smesh_monitor_client.hpp"

auto surface = smesh::skin(mesh);
sviz::send_smesh_surface("127.0.0.1", 8081, "contact-surface", surface);
```

The adapter copies the existing `surface->points()` and `surface->elements()`
values into the monitor message. It does not call `smesh::manage_host_buffer`
or `smesh::Buffer::own`, so the original SFEM/SMesh shared buffers remain the
only owners of their allocations.

Send a single quad:

```cpp
std::array<std::array<float, 3>, 4> quad = {{
    {{0, 0, 0}}, {{1, 0, 0}}, {{1, 1, 0}}, {{0, 1, 0}}}};

sviz::send_single_quad("127.0.0.1", 8081, "one-quad", quad);
```

Send the included quadrilateral/vector example:

```sh
./scripts/send_monitor_example.py 127.0.0.1 8081
```

With the default server ports, the same command can be shortened to:

```sh
./scripts/send_monitor_example.py
```

Then open `http://127.0.0.1:8080/monitor` in the browser. The server exposes the
latest snapshot at `/monitor.bin`, retained snapshots at `/monitor.bin?id=N`,
the retained message list at `/monitor-list.json`, and the browser clear action
at `POST /monitor-clear`.
