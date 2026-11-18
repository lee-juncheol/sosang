/* Used only when cross-compiling the Windows app from macOS (scripts/release-app.mjs).
 * clang-cl looks like MSVC to libwebp, which then compiles its SSE4.1 files without the
 * flags clang needs. Defining HAVE_CONFIG_H makes libwebp read this empty file and rely on
 * the features its build script declares, so it builds with SSE2 only. */
