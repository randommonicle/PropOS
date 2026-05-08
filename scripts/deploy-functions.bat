@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: deploy-functions.bat
:: Deploys all Supabase Edge Functions with correct flags.
::
:: Usage:
::   scripts\deploy-functions.bat
::
:: Requires SUPABASE_ACCESS_TOKEN to be set in environment, or set it below.
:: Get a token at: https://supabase.com/dashboard/account/tokens
:: ─────────────────────────────────────────────────────────────────────────────

if "%SUPABASE_ACCESS_TOKEN%"=="" (
  echo ERROR: SUPABASE_ACCESS_TOKEN is not set.
  echo Set it with: set SUPABASE_ACCESS_TOKEN=sbp_...
  exit /b 1
)

set PROJECT_REF=tmngfuonanizxyffrsjy

echo.
echo Deploying dispatch-engine...
npx supabase functions deploy dispatch-engine --project-ref %PROJECT_REF%
if %ERRORLEVEL% neq 0 (
  echo FAILED: dispatch-engine
  exit /b %ERRORLEVEL%
)
echo OK: dispatch-engine

echo.
echo Deploying contractor-response ^(--no-verify-jwt: public endpoint, no auth required^)...
npx supabase functions deploy contractor-response --project-ref %PROJECT_REF% --no-verify-jwt
if %ERRORLEVEL% neq 0 (
  echo FAILED: contractor-response
  exit /b %ERRORLEVEL%
)
echo OK: contractor-response

echo.
echo All functions deployed successfully.
