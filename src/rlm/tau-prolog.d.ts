declare module "tau-prolog" {
  interface Session {
    consult(program: string, callbacks: {
      success: () => void;
      error: (err: unknown) => void;
    }): void;
    query(goal: string, callbacks: {
      success: () => void;
      error: (err: unknown) => void;
    }): void;
    answer(callbacks: {
      success: (ans: unknown) => void;
      fail: () => void;
      error: (err: unknown) => void;
      limit: () => void;
    }): void;
  }

  function create(limit?: number): Session;
  function format_answer(answer: unknown): string | null;

  export default { create, format_answer };
}
