# Exact-image assessment for the Novu staging update

Assessed 2026-10-05; expires 2026-11-04. Covers only the notification worker
and database migration runner with the exact native file inventories in
`staging-novu-runtime-assessment.json`. This is a not-affected assessment,
not acceptance of an exploitable vulnerability or a general CVE allowlist.

The current pinned Node 22/Debian 13 ARM64 base has zero Critical findings and
eleven High package matches across five advisories in the original Grype scan.
The original report is retained as `grype.raw.json`. Grype's supported OpenVEX
input retains reviewed matches under `ignoredMatches`; applicable or unknown
High/Critical findings still fail publication.

## Evidence

| Advisory | Exact-image conclusion | Evidence |
| --- | --- | --- |
| CVE-2026-85091 | Vulnerable code absent | System zlib is 1.3.1; Node reports 1.3.1-e00f703. The affected nonblocking gz code was introduced in 1.3.1.2 by upstream commit 81cc0be. |
| CVE-2026-5435 | No affected execution path | No final ELF imports ns_printrrf, ns_printrr or fp_nquery; no such call exists in the exact Node source. |
| CVE-2026-19499 | No affected execution path | No final ELF imports strfmon/strfmon_l; no such call exists in the exact Node source. |
| CVE-2026-95619 | Susceptible aligned-new implementation absent | Disassembly of the exact ARM64 libstdc++ aligned-new function calls posix_memalign. Upstream explicitly excludes this implementation from the overflow. Other matched GCC packages do not implement aligned new. |
| CVE-2026-102010 | Vulnerable header template absent | Upstream patch affects ext/pb_ds/detail/binary_heap_/erase_fn_imps.hpp. No PBDS include/use exists in Node's source or final ELF symbols/content. The migration's extra native modules are the existing Argon2 C prebuilds. |

The official Node 22.23.3 source archive was verified against its published
SHA-256: `bd97093e1a1e9243338950c174a693a64d4e0926a9c6ce259962bc58d5e96909`.
All 11,700 C/C++/header/build source files were searched; none contains the
affected glibc calls or PBDS usage. Final export inspected 283 worker ELF files
and 291 migration ELF files, including all bundled foreign ABI prebuilds.
The exact ARM64 libstdc++ SHA-256 is
`fff1f0050a33ddf29c44634c7639ac16e2573a61e3daab4fcc4c007b432ccf19`.
Its `_ZnwmSt11align_val_t` function has a direct branch to
`posix_memalign@plt` at offset `0xaa218`; the susceptible rounding path is absent.

## Enforcement

`scripts/assess-staging-runtime.py` exports the exact image and checks every
ELF pathname/hash, platform, affected imports, expiry, CVE and package version.
It emits OpenVEX only after these checks. New CVEs, Critical findings, a changed
package, changed/additional native binary, other component or expired assessment
fail closed. The JavaScript publisher also verifies the assessed report,
original scan, VEX, policy and transferred archive hashes, then repeats the
native image assessment after loading the archive before pushing to ECR.

The original/assessed scans and VEX travel with the SBOM and publication receipt.
Updating the base, native modules or this policy requires a new assessment.
No `--only-fixed`, severity downgrade or blanket ignore is enabled.

## Primary references

- [zlib introducing commit](https://github.com/madler/zlib/commit/81cc0bebedd935daeb81b0b6e475d8786b51af3d)
- [GNU glibc advisory](https://sourceware.org/pipermail/libc-announce/2026/000057.html)
- [glibc formatting advisory](https://security-tracker.debian.org/tracker/CVE-2026-19499)
- [GCC aligned-new fix and unaffected posix_memalign implementation](https://github.com/gcc-mirror/gcc/commit/59d235ffa5a69231eb42e5290d52dc8c90d28b7a)
- [GCC PBDS header-template fix](https://github.com/gcc-mirror/gcc/commit/aaa8351f4d2e636f9680a1f0a8ebc2f0a60611e6)
- [Official Node source checksums](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)
- [Grype OpenVEX behavior](https://oss.anchore.com/docs/guides/vulnerability/filter-results/)
