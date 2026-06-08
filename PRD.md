Concept: 
Based on SFEM (https://github.com/zulianp/sfem, submodule is located in external/sfem), SVIZ is a browser (WebAssembly and WebGL) based GUI that allows to inspect meshes and manipulate them
From SFEM use the branch smesh.
1) The server accepts POST of meshes in binary format, composed by a metadata header yaml style and arrays (see SMESH io to have a reference)
2) It accepts single geomeric primitives: triangle, quadrialteral, tetrahedron, hexahedron, vector with origin, etc
3) Meta data includes a path (used to organize the data hierarchically) and text
4) It supports tempral sequences, groups or individual mesh primitives, the 


TODOs:
1) Set-up a proper CMake project with the necessary dependencies and create a hello world example creating and displaying a cube generate with smesh::Mesh (part of smesh, which is an sfem submodule)
