# [1.2.0](https://github.com/cubicecho/symphony/compare/v1.1.0...v1.2.0) (2026-11-28)

### Bug Fixes

* **compile:** resolve route names through Babel scopes ([ed51237](https://github.com/cubicecho/symphony/commit/ed51237faa8df3c6e0dc21fb8567bb3774668e19))
* **config:** require positive whole numbers for the SUBSCRIPTION_* limits ([edd0807](https://github.com/cubicecho/symphony/commit/edd08079a4e91a5750b6b31011466c642f50ed71)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **proxy:** route streams on the operation, and close them cleanly ([a20edcd](https://github.com/cubicecho/symphony/commit/a20edcd53c0e68509bb85d31770e47822b2e4685)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **runtime:** give each subpage a fresh route view ([8de1fec](https://github.com/cubicecho/symphony/commit/8de1fec98bbd2caf662c6c29ff95d0c1ffd70979))
* **runtime:** keep useSubscription's backoff, limit and callback sound ([9985d46](https://github.com/cubicecho/symphony/commit/9985d46984623be00333a57ef5632e3ac1e14991)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **web:** clear a module's failure when its path changes ([993f37f](https://github.com/cubicecho/symphony/commit/993f37f31e8fe76554fca70c09abe690b60e8c9d))
* **web:** keep the page's other module paths through a full-page visit ([cbead61](https://github.com/cubicecho/symphony/commit/cbead61859af5039991aba072415a73ad51c40ed))
* **web:** make item paths from the URL start with a slash ([618c7df](https://github.com/cubicecho/symphony/commit/618c7df0bc1db89b7197cf95756c48da438ba66d))
* **web:** start an editor preview at the path its link opened ([73da83c](https://github.com/cubicecho/symphony/commit/73da83ca399fc2cdc3dfad5ed6ba9b15791a3fc1))

### Features

* **compile:** check literal route paths against the module's Routes ([da4089a](https://github.com/cubicecho/symphony/commit/da4089a8a844b25b0f3e1d235c2e86f7f6d56ee3))
* **mcp:** refuse subscriptions in run_query ([2728d3f](https://github.com/cubicecho/symphony/commit/2728d3fce9eed645bdd42c343bc12a58289fba79)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **proxy:** stream subscriptions over SSE ([db07922](https://github.com/cubicecho/symphony/commit/db07922330af82cacfd30f99f399b94bc1396eb8)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **runtime:** add Routes, RouteLink and useRoute to the module runtime ([bd36b70](https://github.com/cubicecho/symphony/commit/bd36b70564ca65ef428c24716156f7d8a52a0dc4))
* **runtime:** add useSubscription to the module runtime ([638ddc8](https://github.com/cubicecho/symphony/commit/638ddc864511bfa7a6757ad5754957f37fa80e99)), closes [#6](https://github.com/cubicecho/symphony/issues/6)
* **web:** open a module full page outside edit mode ([fbf3dca](https://github.com/cubicecho/symphony/commit/fbf3dcaa5c2a0e5f919d4b508aa6b93bacc8b5a3))
* **web:** open a placed module full page ([3030e88](https://github.com/cubicecho/symphony/commit/3030e88f73411a8be9f44b0eaafca7c35635b2bc))

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
