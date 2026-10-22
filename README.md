# pi-setup

Переносимая сборка Pi. Нужен Node.js ≥22.19. Одна команда устанавливает или обновляет сборку и запускает Pi:

## Установка и обновление

```sh
npx --yes --package="https://codeload.github.com/GeorgeTyupin/pi-setup/tar.gz/refs/heads/main?v=0.2.1" pi-setup
```

```text
pi-setup/
├── extensions/
│   ├── codex-footer/              # Лимиты Codex/ChatGPT
│   ├── compact-footer/            # Компактный footer и название сессии
│   ├── inline-skill-autocomplete/ # Выбор скилла внутри сообщения
│   ├── manual-skills/             # Скиллы вызываются только явно
│   ├── new-named-session/         # Новая сессия с названием
│   └── skill-namespaces/          # Команды /pi:, /work:, /other:
├── skills/
│   ├── code-review/
│   ├── curler/
│   ├── skill-creator-personal/
│   ├── tester/
│   └── to-work/
├── config/settings.base.json
├── scripts/                      # Общий CLI установки и обновления
├── docs/
├── package.json
└── tsconfig.json
```

Внешние расширения: `pi-cd` — смена каталога; `pi-execution-time` — время выполнения; `pi-context-view` — просмотр контекста; `pi-ask-user-question` — вопросы с вариантами; `pi-session-kit` — управление сессиями; `pi-better-edit` — редактирование файлов; `pi-lens` — навигация и диагностика кода; `pi-image-view` — просмотр изображений.
