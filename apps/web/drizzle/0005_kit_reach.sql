ALTER TABLE `nodes` ADD `underscore_from` text GENERATED ALWAYS AS (case
    when substr(path, 1, 1) = '_' then ''
    when instr(path, '/_') > 0 then substr(path, 1, instr(path, '/_') - 1)
    else null end) VIRTUAL;