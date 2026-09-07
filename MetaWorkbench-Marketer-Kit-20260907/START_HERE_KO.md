# Windows에서 Claude에게 소재 작업 맡기기

작업대: <https://meta-ads.rabbithole-studios.io/>

시작 ZIP을 **모두 압축 해제**하고 이 폴더에서 Claude Code를 여세요. `CLAUDE.md`는 Claude의 작업 지침, `rh-meta.mjs`는 작업대 CLI, `start-windows.cmd`는 Windows 실행기입니다. 원본 영상은 별도 소재 폴더에 두어도 됩니다. 이미지·playable 업로드는 아직 지원하지 않습니다.

## 처음 한 번

1. `start-windows.cmd`를 더블클릭합니다. 기본으로 연결 진단(`doctor`)을 실행하고 결과를 보여줍니다. Node.js가 없거나 22 미만이면 <https://nodejs.org/en/download>에서 22 이상을 직접 설치하고 터미널을 다시 여세요. 실행기는 자동 설치, 관리자 권한 요청, ExecutionPolicy 변경을 하지 않습니다.
2. 작업대의 **Claude Code 연결**에서 본인 **7일 토큰**을 발급합니다. 이 폴더에서 사람이 직접 PowerShell을 열어 다음을 실행합니다.

```powershell
.\start-windows.cmd login
.\start-windows.cmd doctor
.\start-windows.cmd whoami
```

`login`의 숨김 입력에만 토큰을 붙여넣습니다. `doctor`의 `"ok": true`로 연결 상태를 확인하고, `whoami`로 본인 이메일을 확인합니다. Claude에게 토큰이나 저장 파일을 넘기지 마세요. 토큰은 7일 뒤 만료되므로 그때 새로 발급해 다시 로그인합니다.

3. 아래 문구의 대괄호를 실제 값으로 바꾸고 Claude에게 전달합니다. 소재 폴더에는 검수한 9:16·1:1·16:9 MP4를 하나씩 둡니다. 각 파일은 512 MiB 이하여야 합니다. 아직 검수하지 않은 항목을 검수했다고 적지 마세요.

## Claude에게 전달할 문구

```text
이 폴더의 CLAUDE.md와 START_HERE_KO.md를 읽고 Rabbit Hole 소재 작업을 완료해 주세요.
소재 폴더: [예: C:\광고 소재\이번 주 영상]
대상 광고 세트: [ID 또는 정확한 이름]
검수한 참조 광고: [ID 또는 정확한 이름]
신규 광고명: [기존 광고와 구분되는 이름]
언어: [예: EN]
검수 범위: 이 폴더의 9:16·1:1·16:9 영상 내용과 참조 광고의 문구·CTA·목적지·배치를 확인했습니다.
승인 범위: 위 설정을 유지하고 이 소재 묶음으로 새 creative와 새 PAUSED 광고 1개를 생성하는 데 승인합니다.

doctor → 대상/참조 조회와 preview → manifest 작성 → check-manifest → prepare 또는 기존 초안 resume → 승인된 submit 1회 → wait → lineage → 증빙 export까지 진행하세요.
이미 명시한 대상·참조·생성 승인에 대해 다시 묻지 마세요. 정보 누락, 후보가 모호한 경우, 검수본 변경이 있을 때만 필요한 내용을 묶어 질문하세요.
토큰 원문이나 credential 파일을 읽지 말고 저장된 로그인을 CLI가 사용하게 하세요. 최초/만료 로그인은 제가 직접 숨김 입력으로 합니다.
기존 광고 변경·활성화·예산 변경은 금지합니다. 응답이 불명확하면 재제출하거나 새 초안을 만들지 말고 같은 작업의 상태를 확인하세요.
본인이 만든 작업이 FAILED_TERMINAL + AD_PAUSED_TIMEOUT이고 확정 광고·creative·최초 이력이 있으면 recheck-paused OPERATION_UUID를 1회 실행하세요. 계속 심사 중이거나 검증 실패이면 같은 작업의 status와 export로 증빙을 남기고 멈추세요. 생성 결과 불명확·기록 누락·다른 오류·다른 사람의 작업은 관리자에게 전달하세요.
재확인 성공 응답 뒤에도 status로 AWAITING_MARKETER_REVIEW 상태를 확인한 후 lineage와 export를 마치세요.
작업 ID·새 광고 ID·실제 최종 상태·증빙 경로와 남은 확인 사항을 알려주세요.
```

생성까지 승인하지 않으려면 **승인 범위**를 “검수와 초안 업로드까지만 진행하고 submit은 하지 마세요”로 바꿉니다. 아직 모르는 ID는 정확한 이름을 적어도 되지만 같은 이름이 여러 개면 Claude가 구분을 요청합니다. 영상이 여러 묶음이면 각 묶음의 이름과 생성 수를 구체적으로 지정하세요. 추가 묶음을 임의로 생성하지 않습니다.

## 파일과 진단 결과

PowerShell에서 경로의 공백·한글을 보존하려면 따옴표를 사용하세요. 아래 명령의 상대 경로는 현재 PowerShell 폴더 기준이며, manifest 안의 상대 영상 경로는 manifest 폴더 기준입니다.

```powershell
.\start-windows.cmd check-manifest "C:\광고 소재\이번 주 영상\manifest.json"
.\start-windows.cmd --help
```

`check-manifest`는 로그인 없이 로컬 JSON/BOM, 파일·MP4 헤더·크기·SHA-256을 검사합니다. 화면비 항목 세 개가 있다는 것과 실제 영상 해상도가 맞다는 것은 다릅니다. 해상도·회전·재생·게임/내용·Meta 호환성·참조 변경은 별도 확인이 필요하며 결과의 `notChecked`를 읽으세요. 검사만으로 업로드나 광고 생성은 일어나지 않습니다.

| 진단/상황 | 할 일 |
| --- | --- |
| Node.js 없음 / 22 미만 | 공식 사이트에서 설치한 뒤 터미널을 다시 엽니다. |
| login 필요 / unauthorized | 본인 7일 토큰을 발급해 직접 `login`합니다. 만료·취소·오입력 여부는 이 응답만으로 구분되지 않습니다. |
| unsafe_permissions | 로컬 NTFS 사용자 프로필을 쓰고 관리자에게 문의합니다. 권한 검사를 우회하지 않습니다. |
| access_redirect / access_html | 운영자에게 API 전용 경로 설정을 확인해 달라고 합니다. 웹 인증을 해제하지 않습니다. |
| 네트워크·서비스 오류 / rate_limited | 결과의 `nextAction`을 확인합니다. 준비·제출을 반복하지 않습니다. |

`doctor`와 `check-manifest`는 정상일 때 종료 코드 0, 조치가 필요하면 1을 반환합니다. Claude는 더블클릭용 대기 없이 ` .\start-windows.cmd doctor`처럼 명령을 명시해서 실행합니다.

## 중단된 작업을 이어갈 때

`prepare`가 출력한 작업 ID를 보관하세요. 업로드 중 끊겨도 `prepare`를 다시 실행하지 않습니다.

```powershell
.\start-windows.cmd status OPERATION_UUID
.\start-windows.cmd resume OPERATION_UUID --manifest ".\manifest.json"
```

ID가 없으면 `list --query "신규 광고명"`으로 기존 초안을 먼저 찾습니다. 같은 원본·설정의 미제출 초안만 재개할 수 있습니다. 이미 제출했거나 생성 결과가 불명확하면 관리자에게 작업 ID와 증빙을 전달합니다.

### 광고 생성 후 상태 확인이 늦어질 때

본인이 초안을 만든 작업(`submitted_by`)이 `FAILED_TERMINAL`이고 오류가 `AD_PAUSED_TIMEOUT`이면 다음을 한 번 실행합니다. 확정된 광고·creative와 최초 이력 기록이 있는 작업만 가능합니다.

```powershell
.\start-windows.cmd recheck-paused OPERATION_UUID
```

이 명령은 기존 광고와 참조·검수 hash·최초 이력·PAUSED 상태·미리보기를 모두 다시 검증합니다. Meta에는 조회만 하며, 모두 통과하면 기존 작업 상태를 갱신합니다. 새 광고 생성이나 기존 광고 수정은 하지 않습니다.

성공 응답 뒤에도 `status`로 `AWAITING_MARKETER_REVIEW` 상태를 확인하고 `lineage`와 `export`를 마칩니다.

계속 `AD_PAUSED_PENDING` 등으로 심사 중이거나 검증을 통과하지 못하면 재확인을 반복하지 말고 같은 작업의 `status`와 `export`로 증빙을 남긴 뒤 관리자에게 전달합니다. `prepare`·`submit`을 다시 실행하지 마세요. 생성 결과 불명확, 확정 ID·최초 이력 누락, 다른 오류, 다른 사람의 작업은 기존 **Owner 안전 재확인** 대상입니다. 이 owner 기능은 CLI가 실행할 수 없습니다.

`AWAITING_MARKETER_REVIEW`는 작업대 검증 완료이며 Meta 심사 승인이나 집행 시작을 뜻하지 않습니다. 재확인도 심사 완료를 강제하지 못합니다. 최종 집행은 마케터가 Ads Manager에서 검수한 뒤 결정합니다.
