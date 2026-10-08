export const RULES = [
  {
    id: '1',
    severity: 10,
    title: 'Run the code. Do not search its source.',
    text: `## 1. Run the code. Do not search its source.

\`\`\`js
// BAD: the text can exist in a comment or in code that never runs.
expect(readFile("access.js")).toMatch(/revokeAccess/)

// GOOD: access must stop after removal.
await removeMember(team, user)
expect(await canAccess(team, user)).toBe(false)
\`\`\`

A source check is not a behavior test.
For example, indexOf("missingCall") returns -1.
So "missingCall comes before save" may pass when the call is missing.

SEVERITY: 10/10 (Critical, MUST be fixed)`,
    criteria: {
      true: 'Every assertion in `test_file` is decided by behavior produced by running the code under test (returned values, thrown errors, calls recorded at the mock boundary), and no assertion could pass or fail because of the source text, ordering, or comments of any implementation file.',
      false: 'At least one assertion in `test_file` is decided by searching or reading text instead of by running the code under test: a file read, a regex or substring match against source, an indexOf/ordering check, a source snapshot, a check that a string merely exists in a file, or a text match on an implementation-produced string such as a generated script.',
    },
  },
  {
    id: '2',
    severity: 10,
    title: 'Do not copy the calculation.',
    text: `## 2. Do not copy the calculation.

\`\`\`js
// BAD: the same wrong formula can pass in both places.
expect(discountPrice(100, 20)).toBe(100 * (1 - 20 / 100))

// GOOD: requirement: 20% off 100 gives 80.
expect(discountPrice(100, 20)).toBe(80)
\`\`\`

Do not copy the function into the test.
Do not use the function to create its own expected answer.

SEVERITY: 10/10 (CRITICAL)`,
    criteria: {
      true: 'Every expected value in `test_file` is a literal or a known-correct example taken from a requirement, fixture or documented example, and not recomputed with the same formula or expression the implementation uses.',
      false: 'At least one expected value in `test_file` is recomputed with the same expression, formula or helper the implementation uses (or by calling the implementation to build its own expectation), so the same wrong result would pass in both places.',
    },
  },
  {
    id: '3',
    severity: 10,
    title: 'Do not mock the behavior you want to test.',
    text: `## 3. Do not mock the behavior you want to test.

\`\`\`js
// BAD: this tests the mock.
mock(canAccess).returns(false)
expect(await canAccess(team, user)).toBe(false)

// GOOD: use a mock for data; run the real access check.
mock(loadMembership).returns(null)
expect(await canAccess(team, user)).toBe(false)
\`\`\`

Mocks are allowed. They must not replace the part this test checks.
Use integration tests to check that real parts work together.

SEVERITY: 10/10 (CRITICAL)`,
    criteria: {
      true: 'Every mock in `test_file` stands in for data or an external boundary (a repository, an HTTP client, the clock), while the behavior the test claims to verify is produced by the real code under test.',
      false: 'In `test_file`, a mock replaces the exact behavior the assertion then checks (the mock returns the value the test asserts on, or the assertion only observes the fake), so the test would still pass with the real implementation broken or removed.',
    },
  },
  {
    id: '4',
    severity: 5,
    title: 'Check the result, not just a log or an internal step.',
    text: `## 4. Check the result, not just a log or an internal step.

\`\`\`js
// BAD: "saved" can be logged without saving anything.
await saveName(user.id, "Ana")
expect(logger.info).toHaveBeenCalledWith("saved")

// GOOD: read back the saved name.
await saveName(user.id, "Ana")
expect((await loadUser(user.id)).name).toBe("Ana")
\`\`\`

Check logs, config values, or call order when a requirement needs them.
Do not freeze import order or private helpers for no reason.

SEVERITY: 5/10 (Medium, fix if it's possible)`,
    criteria: {
      true: 'The assertions in `test_file` check an observable result of the action, or a value read back after it, or a requirement that is specifically about a log line, call order or internal step.',
      false: 'An assertion in `test_file` checks only that a log/info call happened, a private internal step ran, or a call was made, without checking any result the requirement describes.',
    },
  },
  {
    id: '5',
    severity: 5,
    title: 'Make sure the assertion really runs.',
    text: `## 5. Make sure the assertion really runs.

\`\`\`js
// BAD: no rows means no assertions.
const rows = await search("Ana")
rows.forEach(row => expect(row.name).toBe("Ana"))

// GOOD: the test data contains one matching user.
expect(await search("Ana")).toEqual([
  { id: user.id, name: "Ana" }
])
\`\`\`

Do not let empty results, caught errors, or skipped code hide a failure.

SEVERITY: 5/10`,
    criteria: {
      true: 'In `test_file`, the test data and control flow guarantee the assertions execute: expected collections have a known non-zero size and no assertion can be skipped, and failures cannot be swallowed.',
      false: 'In `test_file`, an assertion may never run or may pass vacuously: it loops over possibly-empty results, its expected collection is empty, a surrounding guard can skip it, or an error that should fail the test is caught and ignored.',
    },
  },
  {
    id: '6',
    severity: 10,
    title: 'Do not fix the app inside the test.',
    text: `## 6. Do not fix the app inside the test.

\`\`\`js
// BAD: the test opens the menu itself.
await page.evaluate(() => {
  document.querySelector("#menu").hidden = false
})
await expect(page.locator("#menu")).toBeVisible()

// GOOD: the app must open it.
await page.getByRole("button", { name: "Menu" }).click()
await expect(page.locator("#menu")).toBeVisible()
\`\`\`

Set up test data. Do not add the missing app behavior.

SEVERITY: 10/10`,
    criteria: {
      true: '`test_file` only creates test data and drives the code under test through its public entry points.',
      false: '`test_file` performs the work the application is supposed to perform (setting the flag or state the app should set, unhiding or opening UI the app should open, patching or stubbing the very behavior under test, or bypassing a guard) so it can pass without the application working.',
    },
  },
  {
    id: 'delta-behavior',
    severity: 10,
    scope: 'delta',
    title: 'Assert a value the code computes, not a declaration.',
    text: `## delta-behavior. Assert a value the code computes, not a declaration.

\`\`\`js
// BAD: the assertion reads a generated schema. Break the code that computes the fee,
// delete it, or return a wrong constant - this test still passes.
const spec = OpenApi.fromApi(PaymentApi)
assertEquals(schema.required.includes("collectedPlatformFeePaid"), true)

// GOOD: the assertion reads a value the code produced.
const details = await getInvoice(invoice)
assertEquals(details.collectedPlatformFeePaid, 855)
\`\`\`

A schema, a type, a config constant, a fixture or a mock is not the result of the work.
Ask: if the code that computes the claimed value were wrong or deleted, would this
assertion fail? If it would not fail, it does not test the behavior.

SEVERITY: 10/10 (Critical, MUST be fixed)`,
    criteria: {
      true: 'Every assertion in the added lines is decided by a value the production code computes at run time: a returned body, a value read back, a stored record, a thrown error, or a call recorded at a mock boundary.',
      false: 'At least one assertion in the added lines is decided only by a declaration or a fixture - a generated schema or document, a type-level check, a config constant, a snapshot of either, or a value the test itself built - so the assertion would still pass if the code that computes the claimed value returned a wrong value or was deleted.',
    },
  },
];
