// Резолвер рабочего дерева для задачи: по коду проекта → абсолютный путь репозитория
// и доп. переменные окружения для агента. Маршрутизация повторяет договорённость
// проекта (PROJECT_2 → репозиторий ПС, Bash, GOWORK=off; PROJECT → ai-dev-manager).
//
// Карту можно переопределить через env PROGRAMMER_REPO_MAP (JSON):
//   {"PROJECT_2":{"cwd":"F:/git/PS","env":{"GOWORK":"off"}}, "PROJECT":{"cwd":"..."}}

const DEFAULT_MAP = {
  PROJECT_2: { cwd: 'E:/git/PS', env: { GOWORK: 'off' } },
  PROJECT: { cwd: 'E:/git/ai-dev-manager', env: {} },
};

export function loadRepoMap(env = process.env) {
  const raw = String(env.PROGRAMMER_REPO_MAP || '').trim();
  if (!raw) return DEFAULT_MAP;
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_MAP, ...parsed };
  } catch {
    return DEFAULT_MAP;
  }
}

/**
 * @param {Object} task  захваченная задача (имеет .project, напр. 'PROJECT_2')
 * @param {Record<string,{cwd:string,env?:Object}>} map
 * @returns {{cwd:string, env:Object}}
 * @throws если для проекта нет известного репозитория — лучше явный отказ, чем
 *         запуск агента не в том дереве.
 */
export function resolveRepo(task, map = DEFAULT_MAP) {
  const project = String(task?.project || '').trim();
  const entry = map[project];
  if (!entry || !entry.cwd) {
    throw new Error(`repoResolver: неизвестный проект '${project}' — нет рабочего дерева`);
  }
  return { cwd: entry.cwd, env: entry.env || {} };
}
