# Testing Policy

We follow the Testing Library principle that the more tests resemble the way the software is used, the more confidence they can give us.

- Prefer tests that exercise behavior a user can observe.
- Avoid testing implementation details.
- Prefer accessible, semantic queries.
- Use `data-testid` only when other queries are not practical.

## Test Buckets

- `test/requirements/...` is the curated suite of promoted product requirements.
- `test/supporting/...` is the default bucket for all other useful tests.
- A test is a requirement only because it is explicitly placed under `test/requirements/...`.

## Requirements

- Keep requirement tests small, sparse, and intentional.
- Requirement tests should protect product-defining behaviors, core user journeys, and critical business rules that make the app what it is.
- Route, HTTP, DTO, schema, and storage-contract tests are supporting by default unless they are explicitly promoted because they define the product.

## Supporting

- Supporting tests still matter. They can protect implementation-safety behavior such as dedupe, retry, repair, idempotence, non-mutation, parsing, and schema/index safety.
- Supporting is the default class for any test that has not been explicitly promoted.

## Promotion Rules

- Agents may recommend requirement-test promotions, but do not add or expand `test/requirements/...` unless explicitly directed.
- Use the highest test level that proves the behavior cleanly.
- Delete tests instead of classifying them when they only prove delegation, internal wiring, incidental structure, or CSS token details.

## Project Notes

- New and existing tests default to `test/supporting/...` in this repo unless explicitly promoted.
- Live verification harnesses in `scripts/telegram-live.mjs` and `scripts/smoke-live.mjs` are not requirement tests.

Sources:

- https://testing-library.com/docs/guiding-principles/
- https://testing-library.com/docs/queries/about/
