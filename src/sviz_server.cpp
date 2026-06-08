#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Request {
  std::string method;
  std::string path;
};

std::vector<std::filesystem::path> g_asset_roots;

std::string read_file(const std::filesystem::path &path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    return "";
  }
  return std::string(std::istreambuf_iterator<char>(in),
                     std::istreambuf_iterator<char>());
}

std::filesystem::path executable_dir(const char *argv0) {
  std::filesystem::path exe(argv0);
  if (exe.is_relative()) {
    exe = std::filesystem::current_path() / exe;
  }
  return std::filesystem::weakly_canonical(exe).parent_path();
}

void init_asset_roots(const char *argv0) {
  const auto cwd = std::filesystem::current_path();
  const auto exe_dir = executable_dir(argv0);

  g_asset_roots = {
      cwd,
      exe_dir,
      exe_dir.parent_path(),
  };
}

std::filesystem::path find_asset(const std::string &relative_path) {
  for (const auto &root : g_asset_roots) {
    const auto candidate = root / relative_path;
    if (std::filesystem::exists(candidate)) {
      return candidate;
    }
  }
  return {};
}

std::string missing_asset_message(const std::string &relative_path) {
  std::ostringstream out;
  out << "file not found: " << relative_path << "\nsearched:\n";
  for (const auto &root : g_asset_roots) {
    out << "  " << (root / relative_path).string() << "\n";
  }
  return out.str();
}

void send_all(int fd, const std::string &data) {
  const char *ptr = data.data();
  std::size_t left = data.size();
  while (left > 0) {
    const ssize_t n = ::send(fd, ptr, left, 0);
    if (n <= 0) {
      return;
    }
    ptr += n;
    left -= static_cast<std::size_t>(n);
  }
}

void respond(int fd, int status, const std::string &status_text,
             const std::string &content_type, const std::string &body) {
  std::ostringstream out;
  out << "HTTP/1.1 " << status << ' ' << status_text << "\r\n"
      << "Content-Type: " << content_type << "\r\n"
      << "Content-Length: " << body.size() << "\r\n"
      << "Connection: close\r\n\r\n"
      << body;
  send_all(fd, out.str());
}

Request read_request(int fd) {
  std::string raw;
  char buffer[2048];
  while (raw.find("\r\n\r\n") == std::string::npos) {
    const ssize_t n = ::recv(fd, buffer, sizeof(buffer), 0);
    if (n <= 0) {
      throw std::runtime_error("client closed connection");
    }
    raw.append(buffer, static_cast<std::size_t>(n));
    if (raw.size() > 64 * 1024) {
      throw std::runtime_error("request headers too large");
    }
  }

  std::istringstream line(raw);
  Request req;
  line >> req.method >> req.path;
  return req;
}

std::string content_type(const std::string &path) {
  if (path.size() >= 5 && path.substr(path.size() - 5) == ".html") {
    return "text/html; charset=utf-8";
  }
  if (path.size() >= 3 && path.substr(path.size() - 3) == ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (path.size() >= 5 && path.substr(path.size() - 5) == ".wasm") {
    return "application/wasm";
  }
  if (path.size() >= 4 && path.substr(path.size() - 4) == ".css") {
    return "text/css; charset=utf-8";
  }
  return "application/octet-stream";
}

std::string route_to_file(const std::string &path) {
  if (path == "/") {
    return "web/index.html";
  }
  if (path == "/app.js") {
    return "web/app.js";
  }
  if (path == "/wasm/sviz_wasm.js") {
    return "build-wasm/sviz_wasm.js";
  }
  if (path == "/wasm/sviz_wasm.wasm") {
    return "build-wasm/sviz_wasm.wasm";
  }
  return "";
}

void handle_request(int fd, const Request &req) {
  if (req.method != "GET") {
    respond(fd, 405, "Method Not Allowed", "text/plain; charset=utf-8",
            "method not allowed\n");
    return;
  }

  const std::string file = route_to_file(req.path);
  if (file.empty()) {
    respond(fd, 404, "Not Found", "text/plain; charset=utf-8", "not found\n");
    return;
  }

  const auto asset = find_asset(file);
  const std::string body = asset.empty() ? "" : read_file(asset);
  if (body.empty()) {
    respond(fd, 404, "Not Found", "text/plain; charset=utf-8",
            missing_asset_message(file));
    return;
  }

  respond(fd, 200, "OK", content_type(file), body);
}

int listen_socket(int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    throw std::runtime_error(std::strerror(errno));
  }

  int yes = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) < 0) {
    ::close(fd);
    throw std::runtime_error(std::strerror(errno));
  }
  if (::listen(fd, 16) < 0) {
    ::close(fd);
    throw std::runtime_error(std::strerror(errno));
  }
  return fd;
}

} // namespace

int main(int argc, char **argv) {
  const int port = argc > 1 ? std::atoi(argv[1]) : 8080;
  try {
    init_asset_roots(argv[0]);
    const int server = listen_socket(port);
    std::cout << "SVIZ server listening on http://127.0.0.1:" << port << "\n";
    std::cout << "Serving web client and WebAssembly mesh generator\n";
    std::cout << "Asset search roots:\n";
    for (const auto &root : g_asset_roots) {
      std::cout << "  " << root << "\n";
    }

    for (;;) {
      sockaddr_in client_addr{};
      socklen_t client_len = sizeof(client_addr);
      const int client =
          ::accept(server, reinterpret_cast<sockaddr *>(&client_addr), &client_len);
      if (client < 0) {
        continue;
      }
      try {
        handle_request(client, read_request(client));
      } catch (const std::exception &e) {
        respond(client, 400, "Bad Request", "text/plain; charset=utf-8",
                std::string("bad request: ") + e.what() + "\n");
      }
      ::close(client);
    }
  } catch (const std::exception &e) {
    std::cerr << "sviz_server: " << e.what() << "\n";
    return 1;
  }
}
