// Нормализация JSONB-значений из БД. Идиома «объект или пустой объект»
//   v && typeof v === 'object' ? v : {}
// повторялась ~20 раз по модулям (в т.ч. как разбор tasks.data_card) — сведена сюда.
//
// Семантика идентична исходной идиоме: null/undefined/примитив → {}; массив (тоже
// typeof 'object') возвращается как есть — вызывающий сам решает, ждал ли он объект.
export const asObject = (v) => (v && typeof v === 'object' ? v : {});

// Частый частный случай: карточка задачи из строки БД (tasks.data_card JSONB).
// row может быть null/без поля — защищаемся через ?. и asObject.
export const parseDataCard = (row) => asObject(row?.data_card);
