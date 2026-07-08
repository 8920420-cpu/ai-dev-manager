# Драйвер CLI Keenetic по SSH (net-ssh): интерактивный shell, команды из ARGV.
require 'net/ssh'

prompt = /\([\w.\/-]+\)>\s*$/
buf = +''
out = []

Net::SSH.start(ENV.fetch('RHOST'), ENV.fetch('RUSER'),
               password: ENV.fetch('RPASS'), timeout: 20,
               verify_host_key: :never, non_interactive: true) do |ssh|
  ch = ssh.open_channel do |c|
    c.request_pty(term: 'vt100', chars_wide: 200)
    c.send_channel_request('shell')
    c.on_data { |_, d| buf << d }
  end
  wait_prompt = lambda do |deadline|
    until buf.gsub(/\e\[[0-9;]*[A-Za-z]/, '') =~ prompt
      raise 'prompt timeout' if Time.now > deadline
      ssh.process(0.2)
    end
  end
  wait_prompt.call(Time.now + 20)
  ARGV.each do |cmd|
    buf.clear
    ch.send_data(cmd + "\r")
    wait_prompt.call(Time.now + 30)
    out << "### CMD: #{cmd}\n" + buf.gsub(/\e\[[0-9;]*[A-Za-z]/, '')
  end
  ch.send_data("exit\r")
  ssh.loop(1) { false }
end
puts out.join("\n")
