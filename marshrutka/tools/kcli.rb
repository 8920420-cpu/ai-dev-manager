# Драйвер CLI Keenetic по telnet: логин + команды из ARGV, вывод в stdout.
# Keenetic шлёт ANSI-последовательности (\e[K) после приглашений — без якорей \z.
require 'net/telnet'

host = ENV.fetch('RHOST')
user = ENV.fetch('RUSER')
pass = ENV.fetch('RPASS')
prompt = /\([\w.\/-]+\)>/

def clean(s)
  s.gsub(/\e\[[0-9;]*[A-Za-z]/, '')
end

t = Net::Telnet.new('Host' => host, 'Port' => 23, 'Timeout' => 30, 'Prompt' => prompt)
t.waitfor(/Login:/)
t.puts(user)
t.waitfor(/Password:/)
t.puts(pass)
t.waitfor(prompt)

ARGV.each do |c|
  puts "### CMD: #{c}"
  begin
    puts clean(t.cmd(c))
  rescue Timeout::Error, Net::ReadTimeout
    puts "### TIMEOUT on: #{c}"
  end
end
t.puts('exit')
t.close
