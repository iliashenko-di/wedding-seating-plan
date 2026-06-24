# План рассадки

Статический веб-редактор свадебной рассадки: гости, свободная расстановка столов, точные места, шаблоны, экспорт PNG и перенос проекта через JSON.

## Локальный запуск

```bash
npm install
npm run dev
```

Проверки:

```bash
npm test
npm run build
```

## GitHub Pages

Workflow `.github/workflows/deploy.yml` публикует папку `dist` после каждого push в `main` или `master`.

В настройках репозитория откройте **Settings → Pages** и выберите **Source: GitHub Actions**.
