# Capture Retry Jobs Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, task by task. No implementation delegation requested.

**Goal:** 서버에서 계속되는 중복 안전 단건/전체 재시도와 자동 상태 갱신/중지.
**Architecture:** KV 작업 메타데이터와 기존 retryOne/복구 이력을 연결하고 capture controller가 한 항목씩 실행한다. API는 즉시 접수/조회하며 Viewer는 결과를 자동 추적한다.
**Tech Stack:** 기존 TypeScript/iii/StateKV/Viewer DOM/Vitest/Chromium.
**Spec:** docs/superpowers/specs/2026-10-20-capture-retry-jobs-design.md

## Global Constraints

원문 및 실패 이력 보존, 작업 하나만 활성, 시작 시 dead snapshot 최대10000, 동일 UUID 보존, 저장 인증 전 실행 금지. 운영 적용/전체 재시도/장기기억 저장 제외.

## Review Focus

- 저장 후 응답 유실/재시작 시 같은 UUID로 재확인
- 중지와 현재 항목 완료 경합에서 중지 신호 보존
- waiting 예약을 최종 완료로 오판하지 않음
- 새로 발생한 격리를 기존 전체 작업에 추가하지 않음
- API 불확실/닫힌 창/중복 클릭으로 새로운 작업을 만들지 않음

## Tasks

- [x] 작업 관리 회귀를 RED로 확인. capture/retry-jobs.ts와 schema, controller lifecycle을 구현하여 GREEN. 완료·실패·waiting·저장 실패·재시작·중지 경합 검사.
- [x] API auth/입력 경계 RED→GREEN. 신규 jobs 및 stop은 whitelist하며 기존 API 호환 보존.
- [x] Viewer 단건/전체/중지·진행률·자동 조회·목록 갱신 RED→GREEN. 모바일/desktop 실제 Chromium 검사.
- [x] 전체 unit/build/docs/skills/compat/타입 baseline 및 격리 실제 엔진 시험. 변경 기록/수동 기억 검토 작성. 후보 발행·등록 결과는 workspace 영수증에서 추적하며 운영 적용은 하지 않음.

추가 승인 범위: 단계별 처리 현황 접기/펼치기 및 자동 갱신 중 상태 유지. 실제 Chromium 회귀에 포함한다.
