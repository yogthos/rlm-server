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

% ── Blocking vs advisory rollup ────────────────────────────────────────────
%
% blocking_violation/2 is what the enforcement pipeline gates on. Advisory
% rules are queried but don't block by themselves.

blocking_violation(cycle, F)               :- call_cycle(F).
blocking_violation(import_cycle, M)        :- import_cycle(M).
blocking_violation(extreme_complexity, F)  :- cyclomatic(F, C), C > 15.

advisory_violation(dead_code, F)           :- dead_code(F).
advisory_violation(length, F)              :- length_violation(F, _).
advisory_violation(nesting, F)             :- nesting_violation(F, _).
advisory_violation(unused_export, F)       :- unused_export(F).
advisory_violation(complexity, F)          :- complexity_violation(F, _).
