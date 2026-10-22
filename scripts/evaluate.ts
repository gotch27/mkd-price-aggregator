import { readFile, writeFile, mkdir } from "node:fs/promises";
import { settings } from "@/nextsignal/config";
import { equivalent } from "@/nextsignal/services/ai";
import { pool } from "@/nextsignal/services/database";
if (!settings.matching.ai.enabled)
  throw new Error(
    "Configure and explicitly enable AI before running the paid evaluation",
  );
try {
  const pairs = JSON.parse(
    await readFile("tests/fixtures/matching-evaluation.json", "utf8"),
  ) as { a: string; b: string; same: boolean }[];
  const answers = [];
  for (const pair of pairs) {
    const probability = await equivalent(
      { a: { name: pair.a }, b: { name: pair.b } },
      null,
    );
    answers.push({
      ...pair,
      probability,
      accepted:
        probability !== null && probability >= settings.matching.threshold,
    });
  }
  const accepted = answers.filter((a) => a.accepted),
    correct = accepted.filter((a) => a.same),
    falseLinks = accepted.filter((a) => !a.same);
  const precision = accepted.length ? correct.length / accepted.length : null;
  const positives = answers.filter((a) => a.same).length;
  const recall = positives ? correct.length / positives : null;
  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/matching-evaluation.json",
    JSON.stringify(
      {
        model: settings.matching.ai.model,
        threshold: settings.matching.threshold,
        precision,
        recall,
        abstained: answers.length - accepted.length,
        false_links: falseLinks.length,
        answers,
      },
      null,
      2,
    ),
  );
  console.info({
    precision,
    recall,
    accepted: accepted.length,
    false_links: falseLinks.length,
    report: ".data/matching-evaluation.json",
  });
  if (falseLinks.length || !accepted.length) process.exitCode = 1;
} finally {
  await pool.end();
}
