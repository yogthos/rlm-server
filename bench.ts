/**
 * Round 3 — problems requiring execution/verification to get right.
 * These test whether the model can catch its own errors.
 */
import { getLlama, LlamaChatSession } from "node-llama-cpp";

const MODEL_PATH = "models/Qwen3.6-35B-A3B-Q8_0.gguf";

const TASKS = [
  {
    name: "Generate and verify regex",
    prompt: `Write a JavaScript regex that matches valid IPv4 addresses (like 192.168.1.1) but NOT invalid ones like 256.1.1.1, 1.2.3.4.5, or 01.01.01.01 (no leading zeros). Give the regex and test it on these exact strings, reporting true/false for each:
"192.168.1.1", "10.0.0.1", "256.1.1.1", "1.2.3.4.5", "01.01.01.01", "0.0.0.0", "255.255.255.255", "192.168.01.1", "1.1.1", "123.045.067.089"`,
  },
  {
    name: "Find the bug in concurrent code",
    prompt: `This JavaScript has a race condition bug. Find it and explain what can go wrong:

let balance = 100;

async function withdraw(amount) {
  if (balance >= amount) {
    // Simulate async database check
    await new Promise(r => setTimeout(r, 10));
    balance -= amount;
    return { success: true, remaining: balance };
  }
  return { success: false, remaining: balance };
}

// Two concurrent withdrawals
async function main() {
  const [r1, r2] = await Promise.all([
    withdraw(80),
    withdraw(80)
  ]);
  console.log("Result 1:", r1);
  console.log("Result 2:", r2);
  console.log("Final balance:", balance);
}

What will the final balance be? Can it go negative?`,
  },
  {
    name: "Multi-step constraint puzzle",
    prompt: `Five friends (Amy, Bob, Cal, Dee, Eve) each ordered a different drink (coffee, tea, juice, water, soda) and a different dessert (cake, pie, ice cream, brownie, cookie). Given:
1. Amy didn't order coffee or tea.
2. The person who ordered cake also ordered coffee.
3. Bob ordered either juice or water.
4. Dee ordered pie.
5. The person who ordered tea also ordered a cookie.
6. Cal didn't order soda.
7. Eve ordered ice cream.
8. Amy didn't order a brownie.
Find each person's drink and dessert.`,
  },
  {
    name: "Generate a correct state machine",
    prompt: `Design and implement a JavaScript finite state machine for a turnstile gate:
- States: locked, unlocked
- Events: coin, push
- Transitions: locked+coin→unlocked, locked+push→locked, unlocked+coin→unlocked, unlocked+push→locked
- Track total coins collected and total pushes
- Start in 'locked' state

Then trace through this exact sequence of events and give the state + coins + pushes after each: coin, push, push, coin, coin, push`,
  },
  {
    name: "Precise floating point arithmetic",
    prompt: `Compute this EXACTLY (not approximately):
Sum of 1/n for n = 1 to 20, expressed as an exact fraction p/q in lowest terms.

This is 1/1 + 1/2 + 1/3 + 1/4 + ... + 1/20

Give the exact numerator and denominator. Show your work for finding the LCD.`,
  },
];

async function main() {
  console.log("Loading model...");
  const llama = await getLlama("lastBuild");
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  const context = await model.createContext({
    contextSize: { min: 8192 },
    flashAttention: true,
  });
  const sequence = context.getSequence();
  console.log(`Context size: ${context.contextSize}\n`);

  for (const task of TASKS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`=== ${task.name} ===`);
    console.log(`${"=".repeat(60)}`);

    const session = new LlamaChatSession({ contextSequence: sequence });

    const start = Date.now();
    const response = await session.prompt(task.prompt, {
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 3000,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`Time: ${elapsed}s`);
    console.log(`Answer:\n${response}`);
  }

  sequence.dispose();
  context.dispose();
  model.dispose();
}

main().catch(console.error);
