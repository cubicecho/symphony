# [1.1.0](https://github.com/cubicecho/symphony/compare/v1.0.0...v1.1.0) (2026-11-27)

### Bug Fixes

* draft concept proposals from the stored upstreams only ([ad74752](https://github.com/cubicecho/symphony/commit/ad747522203dc9d98ebaf76d09894e9d5e2f3e44))
* print the concept proposal types into the codegen schema ([5fb3488](https://github.com/cubicecho/symphony/commit/5fb3488511444b133f7faf98038cb0920858f724))

### Features

* concepts as data, with a generated subgraph over their member upstreams (spike, track A) ([06c1158](https://github.com/cubicecho/symphony/commit/06c11589890785d2e8c7fd95e333021ad455d0ea))
* **concepts:** create in every default member unless told otherwise ([58bd4b0](https://github.com/cubicecho/symphony/commit/58bd4b043b1ad9ea64dbd0be065694d8b706c2a4))
* **concepts:** follow upstream renames in stored concept definitions ([2faab93](https://github.com/cubicecho/symphony/commit/2faab930de432dc34d581683629649c74472d1c6))
* **concepts:** key every concept entity by one Symphony UUID ([d7d080e](https://github.com/cubicecho/symphony/commit/d7d080e8a6278d01bf5574d543d8bf33c2258fef))
* derive gateway wiring from concepts and apply user overrides ([54d23bf](https://github.com/cubicecho/symphony/commit/54d23bff7539ec8207e8ef62883d4662f05d1b3e))
* draft concepts from the upstreams' schemas and review them as proposals ([9101a19](https://github.com/cubicecho/symphony/commit/9101a193c58c5416e88dc6d0e8507878b89eb89a))
* **gateway:** warn about field conflicts and serve each from one source ([4af0dcf](https://github.com/cubicecho/symphony/commit/4af0dcf39248a3e172b857b3b2f77554f39b1bff))
* let a module read several upstreams, mixed with unified ([bfab8d0](https://github.com/cubicecho/symphony/commit/bfab8d08fd3ce38b03d0771a19f731c5698878d5))
* serve the unified graph as a built-in upstream and re-check modules on recompose ([ff53541](https://github.com/cubicecho/symphony/commit/ff535410d18ec420246c805da5b796b39b0fa1fe))
* spike a runtime-composed unified gateway (Mesh v1 + Hive Gateway) ([4392575](https://github.com/cubicecho/symphony/commit/43925752628f9ab221bc64fdaf1d4c61ff7bbac1))
* store concepts and wiring overrides, and serve the unified gateway at /unified/graphql ([207992c](https://github.com/cubicecho/symphony/commit/207992ceeb409d97965b1bb684b54873e0764963))
* **web:** concepts, wiring and unified status screens ([22595e1](https://github.com/cubicecho/symphony/commit/22595e130510425e314a565a7a44a617bbb86902))
* **web:** propose concepts and review proposals ([cae6954](https://github.com/cubicecho/symphony/commit/cae6954134d4e5b31eb6ddf300e9e8142ad08a32))

# 1.0.0 (2026-11-26)

### Features

* wrap GraphQL APIs in runtime UI modules (phase 1) ([44e5c5d](https://github.com/cubicecho/symphony/commit/44e5c5d08edc894cca20f65e4a12c3f03393605f))
