#include "sviz_mesh_binary.hpp"

#include <exception>
#include <memory>
#include <vector>

namespace {

std::unique_ptr<sviz::DrawMesh> g_mesh;

template <typename T> const void *data_or_null(const std::vector<T> &values) {
  return values.empty() ? nullptr : values.data();
}

} // namespace

extern "C" {

int sviz_create_hex8_cube(int nx, int ny, int nz, double sx, double sy,
                          double sz) {
  try {
    g_mesh =
        std::make_unique<sviz::DrawMesh>(sviz::create_cube_draw_mesh(nx, ny, nz, sx, sy, sz));
    return 1;
  } catch (const std::exception &) {
    g_mesh.reset();
    return 0;
  }
}

const float *sviz_vertices_ptr() {
  return g_mesh ? static_cast<const float *>(data_or_null(g_mesh->vertices))
                : nullptr;
}

const std::uint32_t *sviz_triangles_ptr() {
  return g_mesh ? static_cast<const std::uint32_t *>(
                      data_or_null(g_mesh->triangles))
                : nullptr;
}

const std::uint32_t *sviz_edges_ptr() {
  return g_mesh ? static_cast<const std::uint32_t *>(data_or_null(g_mesh->edges))
                : nullptr;
}

int sviz_vertex_count() {
  return g_mesh ? static_cast<int>(g_mesh->vertices.size() / 3) : 0;
}

int sviz_triangle_index_count() {
  return g_mesh ? static_cast<int>(g_mesh->triangles.size()) : 0;
}

int sviz_edge_index_count() {
  return g_mesh ? static_cast<int>(g_mesh->edges.size()) : 0;
}

int sviz_node_count() { return g_mesh ? static_cast<int>(g_mesh->nodes) : 0; }

int sviz_element_count() {
  return g_mesh ? static_cast<int>(g_mesh->elements) : 0;
}

void sviz_clear_mesh() { g_mesh.reset(); }
}
