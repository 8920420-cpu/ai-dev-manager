# Keenetic (NDMS >= 2.0). Копия встроенной модели oxidized 0.37 + поддержка SSH:
# у встроенной есть только cfg :telnet, а telnet через интернет — плохая идея.
# Файл в ~/.config/oxidized/model/ перекрывает встроенный.
class NDMS < Oxidized::Model
  using Refinements

  comment '! '

  prompt /^([\w.@()-]+[#>]\s?)/m

  cmd 'show version' do |cfg|
    cfg = cfg.each_line.to_a[1..-3].join
    comment cfg
  end

  cmd 'show running-config' do |cfg|
    cfg = cfg.cut_both.each_line.reject { |line| line.match /(clock date|checksum)/ }.join
    cfg
  end

  cfg :telnet do
    username /^Login:/
    password /^Password:/
  end

  cfg :telnet, :ssh do
    pre_logout 'exit'
  end

  cmd :significant_changes do |cfg|
    cfg.reject_lines [
      'Last change:'
    ]
  end
end
