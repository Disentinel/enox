---
world: work_board
books: main
default: main
---

# Доска работ

> Очередь и статус работ выводятся из спецификации и книг исполнителей, а не
> из сообщений. Ведущий пишет ранг и приёмку в `spec/enox.rofl.md`; каждый
> исполнитель пишет только в свой файл `spec/work/<имя>.rofl.md`.
> Загрузка: `npm run repl -- spec/enox.rofl.md spec/work/*.rofl.md`, затем
> `? R is next`, `? R awaits review`, `? R is in progress by W`, `? R is blocked for W by T`.

Declared as facts:

- <a id="queued"></a>A requirement R is queued at a rank N
- <a id="accepted"></a>A requirement R is accepted at a revision V
- <a id="takes"></a>A worker W takes a requirement R
- <a id="finished"></a>A worker W finished a requirement R at a revision V
- <a id="blocked"></a>A worker W is blocked on a requirement R by a text T

## Правила

<a id="open"></a>A requirement R is open if R is queued at some rank, unless R is accepted at some revision.

<a id="behind"></a>A requirement R is behind a requirement Q if R is queued at a rank N, Q is queued at a rank M, M < N, Q is open.

<a id="next"></a>A requirement R is next if R is open, unless R is behind some requirement.

<a id="review"></a>A requirement R awaits review if some worker finished R at some revision, unless R is accepted at some revision.

<a id="progress"></a>A requirement R is in progress by a worker W if W takes R, unless W finished R at some revision.
