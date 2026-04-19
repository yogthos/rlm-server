% Canned structural rules for the hierarchical agent enforcement layer.
% See docs/hierarchical-agents.md §3.4.
%
% Depends on facts emitted by structural-facts.ts + graph/facts.ts:
%   function/3, cyclomatic/2, body_lines/2, nesting/2,
%   defines/4, calls/2, imports/3, exports/2, entry_point/1,
%   member/2, reaches/2 (from BUILTIN_RULES in graph/facts.ts).

% ── Reachability & dead code ────────────────────────────────────────────────

% A function is reachable if it's an entry point, or reachable from one.
reachable(F) :- entry_point(F).
reachable(F) :- entry_point(E), reaches(E, F).

% Dead code: declared function that is not reachable from any entry point.
dead_code(F) :- function(F, _, _), \+ reachable(F).

% ── Complexity thresholds (defaults; override with extra facts if needed) ──

complexity_violation(F, C) :- cyclomatic(F, C), C > 10.
length_violation(F, L)     :- body_lines(F, L), L > 100.
nesting_violation(F, D)    :- nesting(F, D), D > 5.

% ── Call cycles ─────────────────────────────────────────────────────────────

% reaches/2 from BUILTIN_RULES is cycle-safe via visited list.
call_cycle(F) :- calls(F, _), reaches(F, F).

% ── Module-level import cycles ─────────────────────────────────────────────

% imports/3 = imports(ImportingFile, ImportedName, SourceModule).
% Project module edge: file A imports something from file/module B.
module_imports(A, B) :- imports(A, _, B).

module_reaches(A, B) :- module_reaches(A, B, [A]).
module_reaches(A, B, _) :- module_imports(A, B).
module_reaches(A, B, Visited) :-
    module_imports(A, M),
    \+ member(M, Visited),
    module_reaches(M, B, [M|Visited]).

import_cycle(M) :- module_imports(M, _), module_reaches(M, M).

% ── Unused exports ─────────────────────────────────────────────────────────

% Something the module exposes that nothing calls and isn't an explicit entry.
unused_export(F) :-
    exports(_, F),
    \+ calls(_, F),
    \+ entry_point(F).

% ── Cross-file adjacency rules (project-graph checks) ──────────────────────
%
% These fire across ALL accumulated files in the project graph. They surface
% code that is declared but has no relationship to the rest of the program —
% a floating island, a call to a symbol nowhere defined, or a function with
% no caller and no export.

% A function that nobody calls and nobody exports — dead even without an
% explicit entry-point list.
orphan_function(F) :-
    function(F, _, _),
    \+ calls(_, F),
    \+ exports(_, F).

% A call to a symbol that is neither declared as a function/method in any
% file, nor imported from any module. The callee is a phantom.
unresolved_call(Caller, Callee) :-
    calls(Caller, Callee),
    \+ function(Callee, _, _),
    \+ defines(_, Callee, _, _),
    \+ imports(_, Callee, _).

% A file is an "island" if (a) it has at least one declaration, and (b)
% nothing in the project refers to anything inside it — no other file
% imports it, no call edge reaches its functions. The caller of this rule
% decides when to enforce it (first-file exemption).
file_has_incoming(File) :-
    exports(File, Name),
    calls(_, Name).
file_has_incoming(File) :-
    imports(_, _, File).
file_has_outgoing(File) :-
    defines(File, Caller, _, _),
    calls(Caller, _).
file_has_outgoing(File) :-
    imports(File, _, _).

island_file(File) :-
    defines(File, _, _, _),
    \+ file_has_incoming(File),
    \+ file_has_outgoing(File).

% ── Arity mismatch ─────────────────────────────────────────────────────────
%
% Compare declared signature arity against the arity at each call site.
% A mismatch means the caller and callee disagree on the number of
% arguments — almost always a bug (the model wrote a dangling arg,
% forgot one, or changed the signature without updating callers).
%
% A note on tolerance: optional parameters and rest parameters complicate
% this — a 3-arg signature may accept 2 calls legitimately. Our extractor
% counts formal parameters including optionals, so we treat an exact
% mismatch as the signal. Callers can reify optional support later by
% extracting an `optional_count` fact.

% Arity mismatch fires only when:
%   - the function does NOT have a rest parameter (rest → unbounded arity), and
%   - the call arity is outside the legal range [required..total].
% Total declared arity is reported as `Declared` for the error message.
arity_mismatch(F, Declared, Used) :-
    signature(F, _, Declared),
    required_arity(F, Required),
    call_arity(F, Used),
    \+ has_rest_param(F),
    (Used < Required ; Used > Declared).

% ── Blocking vs advisory rollup ────────────────────────────────────────────
%
% blocking_violation/2 is what the enforcement pipeline gates on. Advisory
% rules are queried but don't block by themselves.

blocking_violation(cycle, F)               :- call_cycle(F).
blocking_violation(import_cycle, M)        :- import_cycle(M).
blocking_violation(extreme_complexity, F)  :- cyclomatic(F, C), C > 15.
blocking_violation(unresolved_call, Callee) :- unresolved_call(_, Callee).
blocking_violation(arity_mismatch, F)      :- arity_mismatch(F, _, _).

advisory_violation(dead_code, F)           :- dead_code(F).
advisory_violation(orphan_function, F)     :- orphan_function(F).
advisory_violation(island_file, F)         :- island_file(F).
advisory_violation(length, F)              :- length_violation(F, _).
advisory_violation(nesting, F)             :- nesting_violation(F, _).
advisory_violation(unused_export, F)       :- unused_export(F).
advisory_violation(complexity, F)          :- complexity_violation(F, _).
