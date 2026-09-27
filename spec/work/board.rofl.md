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
> `? R is next`, `? R awaits review`, `? R is in progress by W`, `? R is stuck for W by T`, `? R is taken out of order by W`, `? R is rejected at V`.

Declared as facts:

- <a id="queued"></a>A requirement R is queued at a rank N
- <a id="accepted"></a>A requirement R is accepted at a revision V
- <a id="rejected"></a>A requirement R is rejected at a revision V
- <a id="takes"></a>A worker W takes a requirement R
- <a id="finished"></a>A worker W finished a requirement R at a revision V
- <a id="blocked"></a>A worker W is blocked on a requirement R by a text T

## Правила

<a id="open"></a>A requirement R is open if R is queued at some rank, unless R is accepted at some revision.

<a id="behind"></a>A requirement R is behind a requirement Q if R is queued at a rank N, Q is queued at a rank M, M < N, Q is open.

<a id="next"></a>A requirement R is next if R is open, unless R is behind some requirement.

<a id="settled"></a>A requirement R is settled at a revision V either:

1. if R is accepted at V;
2. if R is rejected at V.

<a id="review"></a>A requirement R awaits review if some worker finished R at a revision V, unless R is settled at V.

<a id="delivered"></a>A worker W delivered a requirement R if W finished R at a revision V, unless R is rejected at V.

> Сдача, которую ведущий отклонил, не считается сдачей: доработка после
> отказа снова «в работе», а не пропадает с доски.

<a id="progress"></a>A requirement R is in progress by a worker W if W takes R, unless W delivered R.

<a id="stuck"></a>A requirement R is stuck for a worker W by a text T if W is blocked on R by T, unless R is accepted at some revision.

> Взято не по порядку: исполнитель работает над R, хотя перед R в очереди
> стоит открытое требование с меньшим рангом. Не запрет, а сигнал ведущему:
> либо приоритет не дошёл, либо ранги устарели.

<a id="out_of_order"></a>A requirement R is taken out of order by a worker W if R is in progress by W, R is behind some requirement.
