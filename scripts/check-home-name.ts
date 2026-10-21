#!/usr/bin/env bun
/**
 * Run:  bun scripts/check-home-name.ts
 *
 * The Home composer turns the first idea into a folder name. A bad name here is
 * a project the person cannot find, or a path the server rejects, so the rules
 * are pinned: lowercase, [a-z0-9-], at most 40 characters, never empty.
 */
import { projectNameFromIdea } from "../web/src/components/homeName.ts";

const cases: [string, string][] = [
  ["A website for my small business", "website-small-business"],
  ["Build me a page to collect RSVPs for my wedding, please", "page-collect-rsvps-wedding"],
  ["", "my-project"],
  ["   !!!   ", "my-project"],
  ["Café & \u{1F370} bakery!", "caf-bakery"],
  ["Make a one-page site for a bakery called Crumb, plain HTML", "one-page-site-bakery-crumb"],
  ["Make a website for my bakery called Crumb", "website-bakery-crumb"],
  ["a b c d e f g Crumb", "b-c-d-e-crumb"],
];
for (const [input, want] of cases) {
  const got = projectNameFromIdea(input);
  if (got !== want) throw new Error(`projectNameFromIdea(${JSON.stringify(input)}) = ${got}, want ${want}`);
}

const long = projectNameFromIdea("supercalifragilisticexpialidocious extraordinarily long words here");
if (long.length > 40 || long !== "supercalifragilisticexpialidocious") throw new Error(`long: ${long}`);

const many = projectNameFromIdea("one two three four five six seven eight");
if (many !== "one-two-three-four-five") throw new Error(`five words: ${many}`);

for (const input of ["Ünïcode words", "a/b\\c ../d", "x".repeat(200)]) {
  const got = projectNameFromIdea(input);
  if (!/^[a-z0-9-]+$/.test(got) || got.length > 40) throw new Error(`charset/length: ${JSON.stringify(got)}`);
}

console.log(`home name: ${cases.length + 5} checks passed`);
