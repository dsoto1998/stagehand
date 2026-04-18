fn main() {
    cc::Build::new()
        .cpp(true)
        .include("vendor/rubberband")
        .file("vendor/rubberband/single/RubberBandSingle.cpp")
        .flag_if_supported("-std=c++17")
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-deprecated-declarations")
        .define("NOMINMAX", None)
        .define("WIN32_LEAN_AND_MEAN", None)
        .compile("rubberband");

    tauri_build::build()
}
