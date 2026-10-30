# pi-setup

Переносимая сборка Pi. Нужен Node.js ≥22.19.

## Установка и обновление

```sh
npx --yes --package="https://codeload.github.com/GeorgeTyupin/pi-setup/tar.gz/refs/heads/main?v=0.2.1" pi-setup
```

## Состав

```text
pi-setup/
├── extensions/
│   ├── codex-footer/              # Лимиты Codex/ChatGPT
│   ├── compact-footer/            # Компактный footer и название сессии
│   ├── inline-skill-autocomplete/ # Выбор скилла внутри сообщения
│   ├── manual-skills/             # Политика автовыбора скиллов
│   ├── new-named-session/         # Новая сессия с названием
│   ├── pi-lens-golangci-adapter/  # Адаптер Pi Lens для golangci-lint v2
│   ├── scoped-thinking/          # Выбор thinking для следующего сообщения
│   ├── skill-namespaces/          # Команды /pi:, /work:, /other:
│   └── verification-runtime/      # Режимы проверок, effort и безопасный curl
├── agents/                       # Профили проверяющих
│   ├── code-reviewer.md           # Ревью кода
│   ├── tester.md                  # Проверка тестами
│   └── curler.md                  # Проверка HTTP
├── skills/
│   ├── code-review/              # Ревью изменений
│   ├── curler/                   # Локальные HTTP-проверки
│   ├── flow/                     # Работа по треку
│   ├── go-architecture/          # Слои и зависимости Go-бэкенда
│   ├── skill-creator-personal/   # Создание скиллов
│   ├── tester/                   # Запуск и анализ тестов
│   ├── to-work/                  # Перенос компонента в рабочий слой
│   └── verify/                   # Координация проверок
├── work/                         # Локальные рабочие компоненты, вне Git
├── config/settings.base.json     # Общие настройки и зависимости
├── config/themes/personal.json   # Catppuccin Mocha и контрастные рамки thinking
├── scripts/                      # Установка, обновление и обслуживание
├── docs/                         # Подробные правила и процедуры
├── package.json
└── tsconfig.json
```

## Сторонние расширения

| Пакет | Назначение |
|---|---|
| `pi-cd` | Смена каталога |
| `pi-execution-time` | Время выполнения |
| `pi-context-view` | Просмотр контекста |
| `@hank-warren/pi-ask-user-question` | Вопросы с вариантами |
| `@injaneity/pi-computer-use` | Просмотр и управление GUI по разрешению пользователя |
| `pi-session-kit` | Управление сессиями |
| `pi-better-edit` | Редактирование файлов |
| `pi-lens` | Навигация и диагностика кода |
| `pi-image-view` | Просмотр изображений |
| `pi-subagents` | Фоновые агенты |
| `pi-web-access` | Поиск в интернете и загрузка страниц |

Документация: [разработка](docs/pi-development.md) · [сопровождение и обновление](docs/pi-maintaining.md) · [публикация](docs/publishing.md).
