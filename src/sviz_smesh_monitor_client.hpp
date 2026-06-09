#ifndef SVIZ_SMESH_MONITOR_CLIENT_HPP
#define SVIZ_SMESH_MONITOR_CLIENT_HPP

#include "sviz_monitor_client.hpp"

#include "smesh_mesh.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sviz {

inline Message &append_smesh_surface(Message &message, const smesh::Mesh &mesh) {
  const auto points = mesh.points();
  if (!points) {
    throw Error("smesh surface has no points");
  }

  const int dim = mesh.spatial_dimension();
  if (dim < 2 || dim > 3) {
    throw Error("smesh surface must have spatial dimension 2 or 3");
  }

  const auto point_count = static_cast<std::size_t>(mesh.n_nodes());
  const auto point_data = points->data();
  std::vector<float> zero_z;

  if (dim == 2) {
    zero_z.assign(point_count, 0.0f);
    message.points_soa(view(point_data[0], point_count),
                       view(point_data[1], point_count),
                       view(zero_z.data(), point_count));
  } else {
    message.points_soa(view(point_data[0], point_count),
                       view(point_data[1], point_count),
                       view(point_data[2], point_count));
  }

  bool has_quad_section = false;
  for (std::size_t block_id = 0; block_id < mesh.n_blocks(); ++block_id) {
    const auto block = mesh.block(block_id);
    if (!block || !block->elements()) {
      continue;
    }

    const auto element_count = static_cast<std::size_t>(block->n_elements());
    const int nodes_per_element = block->n_nodes_per_element();
    const auto element_data = block->elements()->data();

    if (nodes_per_element == 3) {
      message.quads_soa(view(element_data[0], element_count),
                        view(element_data[1], element_count),
                        view(element_data[2], element_count),
                        view(element_data[2], element_count));
      has_quad_section = true;
    } else if (nodes_per_element == 4) {
      message.quads_soa(view(element_data[0], element_count),
                        view(element_data[1], element_count),
                        view(element_data[2], element_count),
                        view(element_data[3], element_count));
      has_quad_section = true;
    } else if (element_count > 0) {
      throw Error("smesh surface blocks must contain TRI3 or QUAD4 elements");
    }
  }

  if (!has_quad_section) {
    const std::uint32_t empty = 0;
    message.quads_soa(view(&empty, 0), view(&empty, 0), view(&empty, 0),
                      view(&empty, 0));
  }

  return message;
}

inline Message &append_smesh_surface(
    Message &message, const std::shared_ptr<smesh::Mesh> &mesh) {
  if (!mesh) {
    throw Error("smesh surface is null");
  }
  return append_smesh_surface(message, *mesh);
}

inline Message smesh_surface_message(const std::string &name,
                                     const smesh::Mesh &mesh) {
  Message message(name);
  append_smesh_surface(message, mesh);
  return message;
}

inline Message smesh_surface_message(const std::string &name,
                                     const std::shared_ptr<smesh::Mesh> &mesh) {
  Message message(name);
  append_smesh_surface(message, mesh);
  return message;
}

inline void send_smesh_surface(const std::string &host, int port,
                               const std::string &name,
                               const smesh::Mesh &mesh) {
  Client(host, port).send(smesh_surface_message(name, mesh));
}

inline void send_smesh_surface(const std::string &host, int port,
                               const std::string &name,
                               const std::shared_ptr<smesh::Mesh> &mesh) {
  Client(host, port).send(smesh_surface_message(name, mesh));
}

} // namespace sviz

#endif // SVIZ_SMESH_MONITOR_CLIENT_HPP
