--- file: package.json ---
{
  "name": "typescript-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run --reporter=tap"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}

--- file: tsconfig.json ---
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": [
    "**/*.ts"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}

--- file: add.ts ---
import runAddTests from "./runAddTests.js";

export default function add(a: number, b: number): number {
  return a + b;
}

--- file: add.test.ts ---
import { describe, it, expect } from "vitest";
import add from "./add.js";

describe("add", () => {
  // Edge cases from spec
  it("both inputs are zero", () => {
    expect(add(0, 0)).toBe(0);
  });

  it("one operand is zero", () => {
    expect(add(5, 0)).toBe(5);
    expect(add(0, -3)).toBe(-3);
  });

  it("operands have opposite signs", () => {
    expect(add(5, -3)).toBe(2);
    expect(add(-10, 7)).toBe(-3);
  });

  it("both operands are negative", () => {
    expect(add(-2, -3)).toBe(-5);
    expect(add(-10, -20)).toBe(-30);
  });

  // Examples from spec
  it("example: a = 5, b = 3 → output: 8", () => {
    expect(add(5, 3)).toBe(8);
  });

  it("example: a = -2, b = 7 → output: 5", () => {
    expect(add(-2, 7)).toBe(5);
  });

  it("example: a = 0, b = -4 → output: -4", () => {
    expect(add(0, -4)).toBe(-4);
  });

  // Additional comprehensive tests
  it("adds two positive numbers", () => {
    expect(add(1, 2)).toBe(3);
    expect(add(100, 200)).toBe(300);
  });

  it("adds floating-point numbers", () => {
    expect(add(1.5, 2.5)).toBe(4);
    expect(add(0.1, 0.2)).toBeCloseTo(0.3);
  });

  it("handles large numbers", () => {
    expect(add(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(add(Number.MIN_SAFE_INTEGER, -1)).toBe(Number.MIN_SAFE_INTEGER - 1);
  });

  it("handles Infinity and -Infinity", () => {
    expect(add(Infinity, 1)).toBe(Infinity);
    expect(add(-Infinity, -1)).toBe(-Infinity);
    expect(add(Infinity, -Infinity)).toBeNaN(); // Infinity + (-Infinity) = NaN
  });

  it("handles NaN", () => {
    expect(add(NaN, 5)).toBeNaN();
    expect(add(3, NaN)).toBeNaN();
  });
});


--- file: runAddTests.ts ---
import add from "./add.js";

export default function runAddTests(): void {
  const testCases = [
    { name: "positive numbers", a: 2, b: 3, expected: 5 },
    { name: "negative numbers", a: -2, b: -3, expected: -5 },
    { name: "zero", a: 0, b: 0, expected: 0 },
    { name: "mixed signs positive result", a: 5, b: -2, expected: 3 },
    { name: "mixed signs negative result", a: -5, b: 2, expected: -3 },
  ];

  for (const test of testCases) {
    try {
      const result = add(test.a, test.b);
      if (result !== test.expected) {
        throw new Error(`Expected ${test.expected}, got ${result}`);
      }
      console.log(`✓ Test passed: ${test.name} (${test.a} + ${test.b} = ${result})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ Test failed: ${test.name} (${test.a} + ${test.b})`);
      console.error(`  Error: ${message}`);
      throw new Error(`Test "${test.name}" failed: ${message}`);
    }
  }
}

--- file: runAddTests.test.ts ---
import { describe, it, expect, vi } from 'vitest';
import runAddTests from "./runAddTests.js";
import add from "./add.js";

// Mock the add function
vi.mock("./add.js");

describe("runAddTests", () => {
  it("should pass all tests when add is correctly implemented", () => {
    // Mock add to return correct results
    const mockAdd = vi.mocked(add);
    mockAdd.mockImplementation((a: number, b: number) => {
      // Simple implementation that passes all test cases
      if (a === 2 && b === 3) return 5;
      if (a === -2 && b === -3) return -5;
      if (a === 0 && b === 0) return 0;
      if (a === 5 && b === -2) return 3;
      if (a === -5 && b === 2) return -3;
      return a + b; // fallback
    });

    const consoleLogSpy = vi.spyOn(console, 'log');
    const consoleErrorSpy = vi.spyOn(console, 'error');

    // Should not throw when all tests pass
    expect(() => runAddTests()).not.toThrow();

    // Should log success messages
    expect(consoleLogSpy).toHaveBeenCalledTimes(5);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("should stop execution and throw error on first failing test", () => {
    const mockAdd = vi.mocked(add);
    // Make first test fail
    mockAdd.mockReturnValue(999); // Wrong result for all calls

    const consoleLogSpy = vi.spyOn(console, 'log');
    const consoleErrorSpy = vi.spyOn(console, 'error');

    // Should throw on first test failure
    expect(() => runAddTests()).toThrow('Test "positive numbers" failed: Expected 5, got 999');

    // Should log error for failed test
    expect(consoleErrorSpy).toHaveBeenCalledWith('✗ Test failed: positive numbers (2 + 3)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Error: Expected 5, got 999');

    // Should not continue to other tests after failure
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("should cover all required categories: positive, negative, zero, mixed signs", () => {
    const mockAdd = vi.mocked(add);
    const calls: Array<[number, number]> = [];
    mockAdd.mockImplementation((a, b) => {
      calls.push([a, b]);
      return a + b;
    });

    runAddTests();

    // Verify all test cases were called
    expect(calls).toEqual([
      [2, 3],      // positive numbers
      [-2, -3],    // negative numbers  
      [0, 0],      // zero
      [5, -2],     // mixed signs positive result
      [-5, 2],     // mixed signs negative result
    ]);
  });

  it("should handle errors from add function gracefully", () => {
    const mockAdd = vi.mocked(add);
    mockAdd.mockImplementation(() => {
      throw new Error("add function error");
    });

    const consoleErrorSpy = vi.spyOn(console, 'error');

    expect(() => runAddTests()).toThrow('Test "positive numbers" failed: add function error');
    expect(consoleErrorSpy).toHaveBeenCalledWith('✗ Test failed: positive numbers (2 + 3)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Error: add function error');

    consoleErrorSpy.mockRestore();
  });
});


--- file: project.integration.test.ts ---
import { describe, it, expect } from 'vitest';
import add from './add.js';
import runAddTests from './runAddTests.js';

describe('project integration', () => {
  it('path runAddTests>add — executes full test suite for add function', async () => {
    // This test verifies the complete test runner works end-to-end
    // We'll capture console output to verify tests run
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);
    
    try {
      // Execute the test runner
      runAddTests();
      
      // Verify something was logged (tests ran)
      expect(logs.length).toBeGreaterThan(0);
      
      // Verify the logs contain test-related output
      const logContent = logs.join(' ');
      expect(logContent).toMatch(/test|pass|fail|add/i);
    } finally {
      console.log = originalLog;
    }
  });

  it('supplementary: direct HTTP-like round-trip simulation', async () => {
    // Simulate an API endpoint that uses add function
    const mockEndpoint = (a: string, b: string) => {
      const numA = Number(a);
      const numB = Number(b);
      return add(numA, numB);
    };
    
    // Test with string inputs (common in HTTP requests)
    expect(mockEndpoint('5', '3')).toBe(8);
    expect(mockEndpoint('-2', '4')).toBe(2);
    expect(mockEndpoint('0', '0')).toBe(0);
  });

  it('supplementary: file I/O integration with add function', async () => {
    // Simulate reading from a file and processing with add
    const mockFileContent = '{"a": 10, "b": -5}\n{"a": 0, "b": 7}';
    const lines = mockFileContent.split('\n');
    
    const results: number[] = [];
    lines.forEach(line => {
      const data = JSON.parse(line);
      results.push(add(data.a, data.b));
    });
    
    expect(results).toEqual([5, 7]);
  });

  it('supplementary: malformed input handling in pipeline', async () => {
    // Test how add behaves with edge cases in a data pipeline
    const processData = (inputs: Array<{a: any, b: any}>) => {
      return inputs.map(input => {
        // Convert to numbers (simulating real-world data cleaning)
        const a = Number(input.a);
        const b = Number(input.b);
        return add(a, b);
      });
    };
    
    const testData = [
      { a: 5, b: 3 },
      { a: null, b: 2 }, // null becomes 0
      { a: undefined, b: 1 }, // undefined becomes NaN
      { a: '7', b: '2' } // strings get converted
    ];
    
    const results = processData(testData);
    expect(results[0]).toBe(8); // Normal case
    expect(results[1]).toBe(2); // null becomes 0
    expect(results[2]).toBeNaN(); // undefined + 1 = NaN
    expect(results[3]).toBe(9); // string conversion works
  });

  it('supplementary: idempotency of mathematical operations', async () => {
    // Verify that add is idempotent for same inputs
    const result1 = add(5, 3);
    const result2 = add(5, 3);
    const result3 = add(5, 3);
    
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
    expect(result1).toBe(8);
    
    // Also test with different call patterns
    const chainedAdd = add(add(2, 3), add(1, 4));
    expect(chainedAdd).toBe(10);
  });

  it('supplementary: integration with other arithmetic in workflow', async () => {
    // Simulate a larger workflow that uses add
    const calculateTotal = (prices: number[], taxRate: number) => {
      const subtotal = prices.reduce((sum, price) => add(sum, price), 0);
      const tax = add(subtotal, -subtotal / (1 + taxRate)); // Calculate tax amount
      return add(subtotal, tax);
    };
    
    const prices = [10.50, 24.99, 5.75];
    const total = calculateTotal(prices, 0.08); // 8% tax
    
    // Manual calculation for verification
    const subtotal = 10.50 + 24.99 + 5.75;
    const expectedTax = subtotal * 0.08;
    const expectedTotal = subtotal + expectedTax;
    
    expect(total).toBeCloseTo(expectedTotal, 10);
  });
});