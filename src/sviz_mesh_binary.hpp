#ifndef SVIZ_MESH_BINARY_HPP
#define SVIZ_MESH_BINARY_HPP

#include "smesh_elem_type.hpp"
#include "smesh_mesh.hpp"

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>

namespace sviz {

struct DrawMesh {
  std::vector<float> vertices;
  std::vector<std::uint32_t> triangles;
  std::vector<std::uint32_t> edges;
  std::uint32_t nodes{0};
  std::uint32_t elements{0};
};

inline DrawMesh mesh_to_draw_mesh(const std::shared_ptr<smesh::Mesh> &mesh) {
  if (!mesh || mesh->n_blocks() != 1 || mesh->element_type(0) != smesh::HEX8) {
    throw std::runtime_error("SVIZ currently expects one HEX8 block");
  }

  const auto surface = smesh::skin(mesh);
  if (!surface) {
    throw std::runtime_error("Unable to extract mesh skin");
  }

  const auto edges = surface->edge_graph();
  if (!edges) {
    throw std::runtime_error("Unable to extract skin edge graph");
  }
  const auto points = surface->points()->data();

  DrawMesh out;
  out.nodes = static_cast<std::uint32_t>(mesh->n_nodes());
  out.elements = static_cast<std::uint32_t>(mesh->n_elements());
  out.vertices.reserve(static_cast<std::size_t>(surface->n_nodes()) * 3);
  out.triangles.reserve(static_cast<std::size_t>(surface->n_elements(0)) * 6);
  out.edges.reserve(static_cast<std::size_t>(edges->nnz()) * 2);

  for (std::ptrdiff_t i = 0; i < surface->n_nodes(); ++i) {
    out.vertices.push_back(points[0][i]);
    out.vertices.push_back(points[1][i]);
    out.vertices.push_back(points[2][i]);
  }

  const auto surface_elements = surface->elements(0)->data();
  const int nodes_per_surface_element = surface->n_nodes_per_element(0);
  for (std::ptrdiff_t e = 0; e < surface->n_elements(0); ++e) {
    if (nodes_per_surface_element == 3) {
      const auto a = static_cast<std::uint32_t>(surface_elements[0][e]);
      const auto b = static_cast<std::uint32_t>(surface_elements[1][e]);
      const auto c = static_cast<std::uint32_t>(surface_elements[2][e]);
      out.triangles.insert(out.triangles.end(), {a, b, c});
    } else if (nodes_per_surface_element == 4) {
      const auto a = static_cast<std::uint32_t>(surface_elements[0][e]);
      const auto b = static_cast<std::uint32_t>(surface_elements[1][e]);
      const auto c = static_cast<std::uint32_t>(surface_elements[2][e]);
      const auto d = static_cast<std::uint32_t>(surface_elements[3][e]);
      out.triangles.insert(out.triangles.end(), {a, b, c, a, c, d});
    } else {
      throw std::runtime_error("Unsupported skin element arity");
    }
  }

  const auto rowptr = edges->rowptr()->data();
  const auto colidx = edges->colidx()->data();
  for (std::ptrdiff_t i = 0; i < edges->n_nodes(); ++i) {
    for (smesh::count_t k = rowptr[i]; k < rowptr[i + 1]; ++k) {
      const auto j = colidx[k];
      if (j > i) {
        out.edges.push_back(static_cast<std::uint32_t>(i));
        out.edges.push_back(static_cast<std::uint32_t>(j));
      }
    }
  }

  return out;
}

inline DrawMesh create_cube_draw_mesh(const std::ptrdiff_t nx,
                                      const std::ptrdiff_t ny,
                                      const std::ptrdiff_t nz,
                                      const double sx, const double sy,
                                      const double sz) {
  if (nx < 1 || ny < 1 || nz < 1) {
    throw std::runtime_error("cube resolution must be positive");
  }
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    throw std::runtime_error("cube dimensions must be positive");
  }

  const auto mesh =
      smesh::Mesh::create_cube(smesh::Communicator::self(), smesh::HEX8, nx, ny,
                               nz, 0, 0, 0, sx, sy, sz);
  return mesh_to_draw_mesh(mesh);
}

} // namespace sviz

#endif
