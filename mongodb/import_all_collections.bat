@echo off
SETLOCAL EnableDelayedExpansion

REM MongoDB URI with URL-encoded username
SET MONGO_URI="mongodb+srv://Wayne:Endanger3d@msps.parfgv6.mongodb.net/MOAT-SmartOps?authSource=admin&retryWrites=true&w=majority&appName=MSPS""

REM Loop through all JSON files in the collections folder
for %%f in (collections\*.json) do (
    echo Importing %%f...
    mongoimport --uri !MONGO_URI! --collection %%~nf --file %%f --jsonArray
)

echo Done importing all collections.
PAUSE
