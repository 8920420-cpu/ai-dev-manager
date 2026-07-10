/**
 * Тихий захват скриншота текущего экрана для виджета «Обратная связь» — как в
 * ПС-виджете (без системного диалога выбора экрана). Использует html2canvas,
 * загруженный лениво (dynamic import), чтобы не утяжелять основной бандл.
 *
 * Возвращает JPEG data URL либо null при любой ошибке — тогда виджет отправляет
 * обращение без скриншота (скриншот не критичен для приёма обращения).
 */
export async function captureScreenshot(): Promise<string | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  try {
    const { default: html2canvas } = await import('html2canvas');
    const canvas = await html2canvas(document.body, {
      logging: false,
      useCORS: true,
      backgroundColor: null,
      // Ограничиваем масштаб — полноэкранный скриншот в высоком DPI слишком тяжёл.
      scale: Math.min(window.devicePixelRatio || 1, 1),
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: document.documentElement.clientHeight,
    });
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}
