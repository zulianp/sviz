cmake_minimum_required(VERSION 3.20)

project(sviz VERSION 0.1.0 LANGUAGES C CXX)

option(SVIZ_BUILD_SERVER "Build the native SVIZ HTTP server" ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(SMESH_ENABLE_MPI OFF CACHE BOOL "" FORCE)
set(SMESH_ENABLE_DEV_MODE OFF CACHE BOOL "" FORCE)
set(SMESH_ENABLE_DEMO OFF CACHE BOOL "" FORCE)
set(SMESH_ENABLE_TESTING OFF CACHE BOOL "" FORCE)

if(EMSCRIPTEN)
    add_subdirectory(external/sfem/external/smesh)

    add_executable(sviz_wasm src/sviz_wasm.cpp)
    target_link_libraries(sviz_wasm PRIVATE smesh::smesh)
    set_target_properties(sviz_wasm PROPERTIES SUFFIX ".js")
    target_link_options(sviz_wasm PRIVATE
        "-sWASM=1"
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sENVIRONMENT=web"
        "-sEXPORT_NAME=createSvizWasmModule"
        "-sEXPORTED_FUNCTIONS=['_sviz_create_hex8_cube','_sviz_vertices_ptr','_sviz_triangles_ptr','_sviz_edges_ptr','_sviz_vertex_count','_sviz_triangle_index_count','_sviz_edge_index_count','_sviz_node_count','_sviz_element_count','_sviz_clear_mesh']"
        "-sEXPORTED_RUNTIME_METHODS=['ccall','HEAPF32','HEAPU32']"
        "-sALLOW_MEMORY_GROWTH=1"
    )
elseif(SVIZ_BUILD_SERVER)
    find_package(Threads REQUIRED)
    add_executable(sviz_server src/sviz_server.cpp)
    target_link_libraries(sviz_server PRIVATE Threads::Threads)

    add_custom_target(sviz_web_assets
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            ${CMAKE_CURRENT_SOURCE_DIR}/web
            $<TARGET_FILE_DIR:sviz_server>/web
    )
    add_dependencies(sviz_server sviz_web_assets)
endif()
