/**
 * FORK-JOIN-001 — авто-вывод рёбер блок-схемы из упорядоченного списка узлов.
 *
 * Рёбра НЕ рисуются вручную: топология выводится из порядка узлов + маркеров
 * fork/join. Узел fork и идущие за ним этапы до ближайшего join образуют
 * параллельные ветки. Узлы одного «семейства ролей» (напр. документационная
 * ветка Auditor → Keeper) сворачиваются в ОДНУ последовательную ветку-цепочку,
 * а не в отдельные параллельные колонки; остальные узлы — по ветке на каждый.
 * Если узлов fork/join нет — рёбра не генерируются (схема остаётся линейной,
 * маршрут по позиции).
 */
import type { Role, SchemeEdge, Stage } from '../../types/project';
import { roleCanonicalCode } from '../../data/presets';

/**
 * Документационная ветка: Documentation Auditor → Documentation Keeper идут
 * последовательно (Keeper потребляет вывод Auditor), а не параллельно. Источник
 * истины о составе ветки — backend (db.js `advanceStuckDocumentationBranches`,
 * `DOC_ROLES`); держим согласованным по каноническим кодам ролей.
 */
const DOCUMENTATION_BRANCH_ROLE_CODES = new Set(['DOCUMENTATION_AUDITOR', 'DOCUMENTATION_KEEPER']);
const DOCUMENTATION_BRANCH_FAMILY = 'DOCUMENTATION';

function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Фолбэк (UUID-подобный) — на случай отсутствия crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface DerivedScheme {
  /** Узлы с гарантированными stageKey (и joinKey на fork). */
  stages: Stage[];
  /** Авто-рёбра (пустой массив для линейной схемы без fork/join). */
  edges: SchemeEdge[];
}

/**
 * Семейство ветки узла: узлы одного семейства сворачиваются в одну
 * последовательную ветку-цепочку. null — узел не относится к семейству (каждый
 * такой узел остаётся отдельной параллельной веткой). Семейство определяется по
 * КАНОНИЧЕСКОМУ коду роли (не по названию) через переданный справочник ролей;
 * без ролей семейства нет — узел остаётся своей веткой.
 */
function branchFamilyOf(stage: Stage, codeByRoleId: Map<string, string>): string | null {
  for (const roleId of stage.roleIds) {
    const code = codeByRoleId.get(roleId);
    if (code && DOCUMENTATION_BRANCH_ROLE_CODES.has(code)) return DOCUMENTATION_BRANCH_FAMILY;
  }
  return null;
}

/**
 * Сгруппировать узлы-ветки между fork и join в цепочки: узлы одного семейства
 * попадают в одну цепочку (в порядке появления), узлы без семейства — каждый в
 * свою одноузловую цепочку. Порядок цепочек стабилен (по первому узлу семейства).
 */
function groupBranchChains(branches: Stage[], codeByRoleId: Map<string, string>): Stage[][] {
  const chains: Stage[][] = [];
  const chainByFamily = new Map<string, Stage[]>();
  for (const b of branches) {
    const family = branchFamilyOf(b, codeByRoleId);
    const existing = family !== null ? chainByFamily.get(family) : undefined;
    if (existing) {
      existing.push(b);
    } else {
      const chain = [b];
      chains.push(chain);
      if (family !== null) chainByFamily.set(family, chain);
    }
  }
  return chains;
}

/**
 * Вывести рёбра из узлов. Возвращает копию узлов (с проставленными stageKey и
 * joinKey на fork) и список рёбер. Для схемы без управляющих узлов edges = [].
 * `roles` — справочник ролей проекта: нужен, чтобы по коду роли определить узлы
 * одного семейства (напр. документационную ветку Auditor → Keeper).
 */
export function deriveSchemeEdges(stages: Stage[], roles: Role[] = []): DerivedScheme {
  const withKeys: Stage[] = stages.map((s) => ({ ...s, stageKey: s.stageKey ?? newKey() }));
  const hasControl = withKeys.some((s) => (s.kind ?? 'stage') !== 'stage');
  if (!hasControl) return { stages: withKeys, edges: [] };

  const codeByRoleId = new Map<string, string>();
  for (const r of roles) {
    const code = roleCanonicalCode(r);
    if (code) codeByRoleId.set(r.id, code);
  }

  const edges: SchemeEdge[] = [];
  let pos = 0;
  const addEdge = (fromKey: string, toKey: string, condition: string | null = null) => {
    edges.push({ fromKey, toKey, condition, position: pos++ });
  };

  const n = withKeys.length;
  let prev: string | null = null;
  let i = 0;
  while (i < n) {
    const node = withKeys[i]!;
    const key = node.stageKey!;
    if (node.kind === 'fork') {
      // Парный join: явно выбранный в настройках узла joinKey приоритетнее
      // позиционного «ближайший join справа» (фолбэк, если выбор не задан или
      // указанный join не найден). Этапы между fork и join — параллельные ветки.
      let j = -1;
      if (node.joinKey) {
        j = withKeys.findIndex(
          (s, idx) => idx > i && s.kind === 'join' && s.stageKey === node.joinKey,
        );
      }
      if (j === -1) {
        j = i + 1;
        while (j < n && withKeys[j]!.kind !== 'join') j += 1;
      }
      const join = j >= 0 && j < n ? withKeys[j]! : null;
      const branches = withKeys.slice(i + 1, j).filter((b) => (b.kind ?? 'stage') !== 'join');
      if (prev) addEdge(prev, key);
      if (join && branches.length) {
        node.joinKey = join.stageKey;
        // Узлы одного семейства (напр. Auditor → Keeper) — одна последовательная
        // ветка-цепочка: F → голова → … → хвост → join. Прочие — по ветке на узел.
        const chains = groupBranchChains(branches, codeByRoleId);
        for (const chain of chains) {
          addEdge(key, chain[0]!.stageKey!);
          for (let k = 0; k < chain.length - 1; k += 1) {
            addEdge(chain[k]!.stageKey!, chain[k + 1]!.stageKey!);
          }
          addEdge(chain[chain.length - 1]!.stageKey!, join.stageKey!);
        }
        prev = join.stageKey!;
        i = j + 1;
        continue;
      }
      // Некорректный fork (нет join/веток) — трактуем линейно, не ломаем схему.
      prev = key;
      i += 1;
      continue;
    }
    if (prev) addEdge(prev, key);
    prev = key;
    i += 1;
  }

  return { stages: withKeys, edges };
}
