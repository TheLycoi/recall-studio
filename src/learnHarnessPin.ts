import { homedir } from "node:os";
import { join } from "node:path";

// Upstream skill files are installed separately, with their own AGPL license.
export const LEARNHARNESS_REVISION = "e69e85269c064c6c9c49a8b06ae78c06e79c4a63";
export const SKILL_HASHES = {
  "LICENSE": "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0",
  "SKILL.md": "0f29a1a5bd9c6f629d76ec442c78799b9d95a83a0322c3a84e71c2c442df09bb",
  "references/data-format.md": "b34f020e9cca38950548c9e21e8cdf86df35d781154bcf2942fe3e323553d926",
  "scripts/_data.py": "fb4abe3f3e99133a9f5a6e28a0733437d1ec37b5e92ba8413102911145cd2883",
  "scripts/graph.py": "95d05acebef77764a215439a95b39b1bc0a81d2595c67349d90053e548e236ed",
  "scripts/sessions.py": "864368dfde5a8c7550ebf80ec77671d9f159f80c0859b248cce20fe799b95dc7",
} as const;
export const DEFAULT_SKILL_DIR = join(homedir(), ".local", "share", "recall-studio", "learnharness", LEARNHARNESS_REVISION);
