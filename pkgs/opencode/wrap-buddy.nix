# wrap-buddy (github:Mic92/wrap-buddy, MIT), as a setup hook: it makes a
# prebuilt ELF run on NixOS by overwriting its entry point with a stub that
# loads a small loader, which loads nixpkgs' ld.so; the headers keep their
# layout (only PT_INTERP becomes PT_NULL). opencode needs it on aarch64:
# patchelf's rewrite of its Bun executable segfaults on GitHub's ARM
# runners. Built here from a pinned source with this flake's nixpkgs, so it
# adds no flake input; the pin is updated by hand.
{
  lib,
  stdenv,
  buildPackages,
  fetchFromGitHub,
  makeSetupHook,
  binutils,
  xxd,
}:
let
  wrapBuddy = stdenv.mkDerivation {
    pname = "wrap-buddy";
    version = "1.0.1-unstable-2026-10-25";
    src = fetchFromGitHub {
      owner = "Mic92";
      repo = "wrap-buddy";
      rev = "ab3140933f4493a7cde6594b62b19e4058cccacf";
      hash = "sha256-aDR/lEWaq/0dV/KU+SObTzKFB2vQ/wXbPJV1lA0wJww=";
    };
    depsBuildBuild = [ buildPackages.stdenv.cc ];
    nativeBuildInputs = [
      binutils
      xxd
    ];
    makeFlags = [
      "CXX_FOR_BUILD=${buildPackages.stdenv.cc}/bin/c++"
      "BINDIR=$(out)/bin"
      "LIBDIR=$(out)/lib/wrap-buddy"
      "INTERP=${stdenv.cc.bintools.dynamicLinker}"
      "LIBC_LIB=${stdenv.cc.libc}/lib"
      # No 32-bit loader and stubs on x86_64: nothing here is 32-bit.
      "BUILD_32BIT="
    ];
    # Its loader and stub go into what it patches, so the licence goes with
    # them.
    postInstall = "install -Dm644 LICENSE $out/share/licenses/wrap-buddy/LICENSE";
    enableParallelBuilding = true;
    meta = {
      description = "Patch ELF binaries with a stub loader for NixOS";
      homepage = "https://github.com/Mic92/wrap-buddy";
      license = lib.licenses.mit;
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  };
in
makeSetupHook {
  name = "wrap-buddy-hook";
  propagatedBuildInputs = [ wrapBuddy ];
} "${wrapBuddy.src}/nix/wrap-buddy-hook.sh"
