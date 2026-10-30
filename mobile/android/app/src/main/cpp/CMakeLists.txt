# SPDX-License-Identifier: GPL-3.0-or-later
# The phone's built-in AI: llama.cpp, compiled into the app, behind a small
# JNI layer (inkleaf-ai.cpp). Only 64-bit ARM phones run the model; on any
# other kind of phone the library is a stub that says "not supported", so
# the app still installs and everything else works.

cmake_minimum_required(VERSION 3.22.1)
project(inkleaf-ai LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    add_library(inkleaf-ai SHARED inkleaf-ai.cpp)
    target_compile_definitions(inkleaf-ai PRIVATE INKLEAF_AI_STUB=1)
    target_link_libraries(inkleaf-ai log)
    return()
endif()

# llama.cpp, pinned to the release the computer app downloads (b11669), so
# both run the same models the same way. Fetched once into app/.llama and
# checked against the exact commit before it's built.
set(LLAMA_TAG b11669)
set(LLAMA_COMMIT 620d2225cc436ab0b001e3200e590e3b286ef9ab)
set(LLAMA_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../.llama/${LLAMA_TAG})

if(NOT EXISTS ${LLAMA_DIR}/CMakeLists.txt)
    find_package(Git REQUIRED)
    message(STATUS "Fetching llama.cpp ${LLAMA_TAG}")
    file(REMOVE_RECURSE ${LLAMA_DIR})
    execute_process(
        COMMAND ${GIT_EXECUTABLE} clone --quiet --depth 1 --branch ${LLAMA_TAG}
                https://github.com/ggml-org/llama.cpp ${LLAMA_DIR}
        RESULT_VARIABLE fetched)
    if(NOT fetched EQUAL 0)
        message(FATAL_ERROR "Couldn't download llama.cpp ${LLAMA_TAG}. Check the internet connection and build again.")
    endif()
endif()
find_package(Git REQUIRED)
execute_process(COMMAND ${GIT_EXECUTABLE} -C ${LLAMA_DIR} rev-parse HEAD
                OUTPUT_VARIABLE head OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT head STREQUAL LLAMA_COMMIT)
    message(FATAL_ERROR "llama.cpp in ${LLAMA_DIR} isn't the expected commit (${head}). Delete that folder and build again.")
endif()

# CPU only. Every ARM variant is built (plain, dot-product, i8mm, SVE...) and
# the best one for the phone is picked when the app starts.
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
add_subdirectory(${LLAMA_DIR} llama)

add_library(inkleaf-ai SHARED inkleaf-ai.cpp)
target_link_libraries(inkleaf-ai llama ggml log)
